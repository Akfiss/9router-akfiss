import crypto from "node:crypto";
import { DefaultExecutor } from "./default.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
const REFRESH_URL = "https://autoglm-api.autoglm.ai/userapi/v1/refresh";

const UPSTREAM_MODELS = [
  { id: "glm-5.2", upstream: "openrouter_glm-5.2", alias: "glm52" },
  { id: "glm-5-turbo", upstream: "zai_glm-5-turbo", alias: "glm5t" },
];

function signHeaders(extra = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sign = crypto.createHash("md5").update(`${APP_ID}&${ts}&${APP_KEY}`).digest("hex");
  return {
    accept: "*/*",
    "content-type": "application/json",
    origin: "https://autoclaw.z.ai",
    referer: "https://autoclaw.z.ai/",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "x-auth-appid": APP_ID,
    "x-auth-timestamp": ts,
    "x-auth-sign": sign,
    "x-product": "autoclaw",
    "x-version": "1.10.0",
    "x-tm": "web",
    "x-channel": "official",
    "x-client-type": "web",
    "x-trace-id": crypto.randomUUID(),
    "x-lang": "zh-CN",
    ...extra,
  };
}

function resolveUpstreamModel(model) {
  const match = UPSTREAM_MODELS.find((m) => m.id === model || m.alias === model);
  return match?.upstream || model;
}

/**
 * AutoclawExecutor — talks to https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw/chat/completions
 *
 * AutoClaw uses a custom signing scheme (MD5 of APP_ID & timestamp & APP_KEY)
 * for every request. The real model is sent via X-Request-Model header, not
 * in the request body — the body's model field is always "x".
 * Token refresh uses a custom endpoint (not standard OAuth).
 */
export class AutoclawExecutor extends DefaultExecutor {
  constructor() {
    super("autoclaw", PROVIDERS.autoclaw || { baseUrl: "", headers: {} });
    this._currentModel = null;
  }

  buildHeaders(credentials, stream) {
    const token = credentials?.accessToken;
    if (!token) {
      throw new Error("autoclaw: missing accessToken");
    }
    const rawToken = token.replace(/^Bearer\s+/i, "");
    const extras = {
      "X-Authorization": rawToken,
      "X-Request-Id": crypto.randomUUID(),
      Accept: stream ? "text/event-stream" : "*/*",
    };
    if (this._currentModel) {
      extras["X-Request-Model"] = resolveUpstreamModel(this._currentModel);
    }
    return signHeaders(extras);
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    return { ...transformed, stream: true, model: "x" };
  }

  async execute(args) {
    this._currentModel = args.model;
    try {
      return await super.execute(args);
    } finally {
      this._currentModel = null;
    }
  }

  needsRefresh(credentials) {
    if (!credentials?.expiresAt) return true;
    const expiresAtMs = Date.parse(credentials.expiresAt);
    if (!Number.isFinite(expiresAtMs)) return true;
    return expiresAtMs - Date.now() < 60 * 60 * 1000;
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials?.refreshToken) {
      throw new Error("autoclaw refresh: missing refreshToken");
    }
    const deviceId = credentials.providerSpecificData?.deviceId;
    if (!deviceId) {
      throw new Error("autoclaw refresh: missing deviceId in providerSpecificData");
    }

    const refreshToken = credentials.refreshToken.replace(/^Bearer\s+/i, "");

    const res = await proxyAwareFetch(
      REFRESH_URL,
      {
        method: "POST",
        headers: signHeaders(),
        body: JSON.stringify({
          source_id: "web",
          device_id: deviceId,
          refresh_token: refreshToken,
        }),
      },
      proxyOptions
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw Object.assign(new Error(`autoclaw refresh failed: ${res.status} ${text}`), {
        recoverable: res.status >= 500,
      });
    }

    const json = await res.json();
    if (json.code !== 0 && json.code !== undefined) {
      throw new Error(`autoclaw refresh: code ${json.code} ${json.message || ""}`);
    }
    const data = json.data || json;
    const accessToken = data.access_token || data.accessToken;
    const newRefreshToken = data.refresh_token || data.refreshToken;

    if (!accessToken || !newRefreshToken) {
      throw new Error("autoclaw refresh: missing tokens in response");
    }

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }
}

export default AutoclawExecutor;
