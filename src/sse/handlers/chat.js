import "open-sse/index.js";

import crypto from "node:crypto";
import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { isBansosHost, validateBansosModel, bansosError } from "@/lib/bansos/policy.js";
import { PUBLIC_MODEL as BANSOS_PUBLIC_MODEL, INTERNAL_MODEL as BANSOS_INTERNAL_MODEL, BANSOS_LIMITS } from "@/lib/bansos/constants.js";
import { acquireBansosChat } from "@/lib/bansos/rateLimiter.js";
import { getBansosUserById } from "@/lib/db/index.js";

const BANSOS_USER_ID_HEADER = "x-9r-bansos-user-id";
const BANSOS_KEY_ID_HEADER = "x-9r-bansos-key-id";

// Converts a policy.bansosError() result (a plain {status, body, headers}
// object, not a Response) into a real Web Response. chat.js is not Next.js
// middleware — there's no NextResponse here — so this mirrors
// dashboardGuard.js's respondWithBansosError() but targets the raw Response
// API, matching this file's own errorResponse()/unavailableResponse() style
// (JSON body + Content-Type + CORS header).
function bansosErrorResponse(result) {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...(result.headers || {}),
    },
  });
}

/**
 * Bansos Gateway pre-dispatch policy gate (Task 8). Only ever called when
 * the caller has already confirmed `isBansosHost(request.headers.get("host"))`
 * — see the note above handleChat for why gating on the Host header (never
 * on the presence of the verified ID headers themselves) is load-bearing for
 * security. Enforces, strictly in this order, all before any getModelInfo
 * call or provider dispatch:
 *   1. verified-ID headers present (stamped by dashboardGuard.js, Task 5)
 *   2. the owning user exists and is active (Task 1's bansosRepo)
 *   3. the emergency kill switch (settings.bansosGatewayEnabled !== false)
 *   4. request body size (BANSOS_LIMITS.maxRequestBody)
 *   5. prompt size (BANSOS_LIMITS.maxPromptSize; see task-8-report.md for
 *      what "prompt" is defined to mean here)
 *   6. the requested model is exactly the public Bansos model
 *   7. the per-user rate + concurrency limiter (Task 6)
 *
 * On success, returns a shallow-cloned body with `model` rewritten to the
 * internal dispatch model (never mutates the caller's original `body` —
 * `clientRawRequest.body` still holds the untouched original for Task 10's
 * prompt-audit feature) plus a ready-to-use bansosContext carrying the
 * limiter's `release()` closure.
 *
 * @returns {Promise<{error: Response} | {body: object, context: object}>}
 */
async function resolveBansosChatRequest(request, body, settings) {
  const userId = request.headers.get(BANSOS_USER_ID_HEADER);
  const apiKeyId = request.headers.get(BANSOS_KEY_ID_HEADER);
  if (!userId || !apiKeyId) {
    // Structurally shouldn't happen — dashboardGuard.js's Bansos branch
    // stamps both headers on every request it lets through — but treat
    // absence as a hard, defensive 401 rather than assuming.
    log.warn("BANSOS", "Missing verified identity headers on Bansos-host request");
    return { error: bansosErrorResponse(bansosError(401, "Missing verified identity", "invalid_request_error", "missing_bansos_identity")) };
  }

  const user = await getBansosUserById(userId);
  if (!user || !user.isActive) {
    log.warn("BANSOS", "Rejected unknown/disabled user", { userId });
    return { error: bansosErrorResponse(bansosError(403, "Account disabled", "invalid_request_error", "user_disabled")) };
  }

  if (settings.bansosGatewayEnabled === false) {
    log.warn("BANSOS", "Gateway disabled via emergency kill switch");
    return { error: bansosErrorResponse(bansosError(503, "Bansos gateway is temporarily disabled", "server_error", "gateway_disabled")) };
  }

  // Body-size guard: prefer the declared Content-Length (cheap, no need to
  // touch the body); fall back to measuring the parsed body's re-serialized
  // byte length when Content-Length is absent/non-numeric (chunked
  // transfer, proxies that drop/rewrite it).
  const declaredLength = Number(request.headers.get("content-length"));
  let bodyByteLength = Number.isFinite(declaredLength) && declaredLength > 0 ? declaredLength : null;
  if (bodyByteLength === null) {
    try { bodyByteLength = Buffer.byteLength(JSON.stringify(body), "utf8"); } catch { bodyByteLength = 0; }
  }
  if (bodyByteLength > BANSOS_LIMITS.maxRequestBody) {
    log.warn("BANSOS", `Request body too large: ${bodyByteLength} bytes`);
    return { error: bansosErrorResponse(bansosError(413, "Request body too large", "invalid_request_error", "request_too_large")) };
  }

  // Prompt-size guard. "Prompt" is interpreted as the serialized `messages`
  // array specifically (not the whole body) — it's the field whose size is
  // actually driven by user-supplied conversation content, as opposed to
  // fixed/small fields like `model`/`stream`/`temperature`. See
  // task-8-report.md for this interpretation call.
  let promptByteLength = 0;
  try { promptByteLength = Buffer.byteLength(JSON.stringify(body?.messages || []), "utf8"); } catch { promptByteLength = 0; }
  if (promptByteLength > BANSOS_LIMITS.maxPromptSize) {
    log.warn("BANSOS", `Prompt too large: ${promptByteLength} bytes`);
    return { error: bansosErrorResponse(bansosError(413, "Prompt too large", "invalid_request_error", "prompt_too_large")) };
  }

  if (!validateBansosModel(body?.model)) {
    log.warn("BANSOS", "Invalid model requested", { model: body?.model });
    return { error: bansosErrorResponse(bansosError(400, "Unsupported model", "invalid_request_error", "invalid_model")) };
  }

  const lease = acquireBansosChat(user.id, {
    requestsPerMinute: user.requestsPerMinute,
    maxConcurrentRequests: user.maxConcurrentRequests,
  });
  if (!lease.ok) {
    const isRpm = lease.reason === "rpm_limit_exceeded";
    const message = isRpm ? "Rate limit exceeded" : "Too many concurrent requests";
    const extraHeaders = lease.retryAfterSeconds != null ? { "Retry-After": String(lease.retryAfterSeconds) } : undefined;
    log.warn("BANSOS", `Rate limiter rejected request: ${lease.reason}`, { userId: user.id });
    return { error: bansosErrorResponse(bansosError(429, message, "rate_limit_error", lease.reason, extraHeaders)) };
  }

  return {
    body: { ...body, model: BANSOS_INTERNAL_MODEL },
    context: {
      userId: user.id,
      apiKeyId,
      requestId: crypto.randomUUID(),
      publicModel: BANSOS_PUBLIC_MODEL,
      internalModel: BANSOS_INTERNAL_MODEL,
      release: lease.release,
      startedAt: Date.now(),
    },
  };
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided). Captured from the
  // ORIGINAL, pre-Bansos-rewrite `body` reference — this is also what
  // preserves the original client-submitted body (public model name intact)
  // for Task 10's prompt-audit feature, since `body` itself gets reassigned
  // to a rewritten clone below for a Bansos request, but clientRawRequest.body
  // keeps pointing at the object captured here.
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }

  const settings = await getSettings();

  // --- Bansos Gateway branch --------------------------------------------
  // Gate strictly on the Host header via isBansosHost(), NEVER on the mere
  // presence of x-9r-bansos-user-id/x-9r-bansos-key-id. Those two headers
  // are only trustworthy because dashboardGuard.js's Bansos-host branch
  // (Task 5) is the ONLY code path that stamps them, after verifying a
  // bns_... key — and that guarantee holds only when the request actually
  // arrived on the Bansos host. dashboardGuard.js's *ordinary* path calls
  // NextResponse.next() with no arguments, which forwards the client's
  // original headers completely unmodified, so on an ordinary local host a
  // client could forge these exact header names itself. Gating on Host
  // first means a forged-header local request can never reach this branch.
  let bansosContext = null;
  const onBansosHost = isBansosHost(request.headers.get("host"));
  if (onBansosHost) {
    const outcome = await resolveBansosChatRequest(request, body, settings);
    if (outcome.error) return outcome.error;
    body = outcome.body;
    bansosContext = outcome.context;
  }

  const modelStr = body.model;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings. Bansos requests authenticate
  // through a completely separate, already-verified credential space
  // (dashboardGuard.js + resolveBansosChatRequest above) — they must never
  // also be gated by the ordinary sk-... key check.
  if (!onBansosHost && settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, bansosContext);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, bansosContext),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, bansosContext),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, bansosContext);
}

/**
 * Handle single model chat request. `bansosContext` is threaded through
 * additively (Task 8) — undefined/null for every ordinary request, in which
 * case this function behaves exactly as before. It is never stored in
 * module-level state: concurrent requests/streams each carry their own
 * instance as a plain parameter.
 *
 * This is a thin safety-net wrapper: it guarantees the Bansos rate-limiter
 * lease (if any) is released on ANY exception thrown out of dispatch,
 * whatever the cause, as a defense-in-depth backstop on top of the explicit
 * release-before-return calls inside dispatchSingleModelChat below. It does
 * NOT release on success — a successful hand-off is Task 9's to release.
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, bansosContext = null) {
  try {
    return await dispatchSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, bansosContext);
  } catch (err) {
    if (bansosContext) {
      try { bansosContext.release(); } catch { /* never let a release bug mask the original error */ }
    }
    throw err;
  }
}

async function dispatchSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, bansosContext) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, bansosContext);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, bansosContext),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    if (bansosContext) { try { bansosContext.release(); } catch { /* never mask the real error */ } }
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        if (bansosContext) { try { bansosContext.release(); } catch { /* never mask the real error */ } }
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        if (bansosContext) { try { bansosContext.release(); } catch { /* never mask the real error */ } }
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      if (bansosContext) { try { bansosContext.release(); } catch { /* never mask the real error */ } }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      },
      bansosContext
    });

    // A successful hand-off means handleChatCore already routed the request
    // into one of chatCore/{sseToJsonHandler,nonStreamingHandler,streamingHandler}.js
    // — those own the bansosContext release from here on (Task 9), not us.
    if (result.success) return result.response;

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs);

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    // No further fallback: this was a pre-response failure from this
    // client's point of view (no handler ever took ownership) — release now.
    if (bansosContext) { try { bansosContext.release(); } catch { /* never mask the real error */ } }
    return result.response;
  }
}
