import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine, buildBansosUsageMeta } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey);
}

/**
 * Wrap a streamController (see open-sse/utils/streamHandler.js's
 * createStreamController) so a Bansos request's concurrency lease is
 * released whenever the stream actually ends — success, error, disconnect,
 * or stall-timeout — none of which have a single synchronous completion
 * point the way the non-streaming handlers do.
 *
 * `handleComplete` fires on the normal end-of-stream path — the SAME path
 * that already ran `onStreamComplete` (via the transform stream's flush()),
 * which already wrote the success usageHistory row and released the lease.
 * So the wrapped `handleComplete` only adds a (harmless, idempotent) extra
 * release() call — no second row.
 *
 * `handleError`/`handleDisconnect` fire on every path that does NOT go
 * through flush()/onStreamComplete (upstream error, client disconnect,
 * stall-timeout abort). These never get a chance to write a usageHistory
 * row otherwise, so the wrapped versions write one here — status
 * "interrupted", tokens zeroed (the DB's numeric columns aren't nullable in
 * practice, but the row is NOT a claim of "confirmed zero tokens" — meta
 * carries `tokensUnavailable: true` specifically so a reader can tell that
 * apart from a genuine zero-token request) — then release.
 *
 * A local `finalized` flag (independent of the underlying streamController's
 * own `disconnected` guard) makes the interrupted-row write idempotent even
 * if more than one of these three hooks were ever invoked for the same
 * request; `release()` itself is already idempotent (rateLimiter.js), so it
 * needs no such guard.
 *
 * Exported for direct unit testing — see tests/unit/bansos-usage-attribution.test.js.
 */
export function wrapStreamControllerForBansos(streamController, bansosContext, { provider, model, connectionId, apiKey, endpoint }) {
  let finalized = false;

  const finalizeInterrupted = () => {
    if (finalized) return;
    finalized = true;
    saveUsageStats({
      provider, model, connectionId, apiKey, endpoint,
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      status: "interrupted",
      meta: buildBansosUsageMeta(bansosContext, { tokensUnavailable: true }),
      label: "STREAM USAGE",
      silent: true,
    });
  };

  return {
    ...streamController,
    handleError: (err) => {
      streamController.handleError(err);
      finalizeInterrupted();
      bansosContext.release();
    },
    handleDisconnect: (reason) => {
      streamController.handleDisconnect(reason);
      finalizeInterrupted();
      bansosContext.release();
    },
    handleComplete: () => {
      streamController.handleComplete();
      bansosContext.release();
    },
  };
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, streamDetailId, pxpipe, reqTag, log, bansosContext }) {
  if (onRequestSuccess) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  // When upstream returns HTML/text instead of SSE (e.g. Cloudflare 5xx error
  // page), piping it through the SSE transform stream causes Next.js
  // "failed to pipe response" and crashes the chat router. Read the body,
  // pull a short human-readable message from the <title>, sanitize it, and
  // return a clean JSON error instead. The message is stripped of HTML tags
  // and clamped so untrusted upstream text never reaches the client verbatim
  // (the UI may render error.message as HTML).
  const upstreamContentType = (providerResponse.headers.get('content-type') || '').toLowerCase();
  if (upstreamContentType && !upstreamContentType.includes('text/event-stream') && !upstreamContentType.includes('application/json')) {
    const bodyText = await providerResponse.text().catch(() => '');
    const titleMatch = bodyText.match(/<title>([^<]+)<\/title>/i);
    const sanitizedTitle = (titleMatch?.[1] || '').replace(/<[^>]*>/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
    const shortMsg = sanitizedTitle
      || (bodyText.length < 200 ? bodyText.replace(/<[^>]*>/g, '').trim().slice(0, 160) : `Upstream returned non-SSE response (${upstreamContentType})`);
    const status = providerResponse.status || 502;
    if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · non-SSE (${upstreamContentType})\n    ${shortMsg}`);
    else console.warn(`[STREAM] ${provider} | ${model} | blocked pipe: ${shortMsg} [${status}]`);
    streamController?.handleError?.(new Error(`upstream non-SSE: ${status}`));
    return {
      success: false,
      response: new Response(JSON.stringify({ error: { message: `[${status}]: ${shortMsg}` } }), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }),
    };
  }

  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey });

  // Responses passthrough: synthesize response.failed + [DONE] if the stream aborts/stalls before a terminal event
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const onAbortTerminal = isResponsesPassthrough ? buildAbortedResponsesTerminalBytes : null;
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;

  // Bansos requests: wrap the controller so error/disconnect/stall-timeout
  // (which never reach onStreamComplete/flush()) still write an interrupted
  // usageHistory row and release the lease. Ordinary requests get the exact
  // same `streamController` reference untouched — no new behavior for them.
  const effectiveStreamController = bansosContext
    ? wrapStreamControllerForBansos(streamController, bansosContext, { provider, model, connectionId, apiKey, endpoint: clientRawRequest?.endpoint })
    : streamController;
  const transformedBody = pipeWithDisconnect(providerResponse, transformStream, effectiveStreamController, onAbortTerminal, stallTimeoutMs);

  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    pxpipe,
    status: "success"
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  return {
    success: true,
    response: new Response(transformedBody, { headers: SSE_HEADERS })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, pxpipe, reqTag, log, bansosContext }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const onStreamComplete = (contentObj, usage, ttftAt) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming" },
      pxpipe,
      status: "success"
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });

    // Persist stream usage to DB (no console line; the "📊 done" line below is authoritative)
    saveUsageStats({
      provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE", silent: true,
      meta: buildBansosUsageMeta(bansosContext), status: bansosContext ? "success" : undefined
    });
    if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency }));

    // Success completion point for a Bansos lease. This fires from the
    // transform stream's flush() — the normal end-of-stream path — which is
    // mutually exclusive with the error/disconnect/stall-timeout paths
    // wrapStreamControllerForBansos covers (the underlying streamController's
    // own `disconnected` guard ensures at most one of handleComplete/
    // handleError/handleDisconnect ever does real work per request). The
    // wrapped handleComplete() also calls release() after this fires, but
    // release() is idempotent so that's a no-op, not a double-release bug.
    if (bansosContext) bansosContext.release();
  };

  return { onStreamComplete, streamDetailId };
}
