import { NextResponse } from "next/server";
import {
  createProviderConnection,
  getProviderConnectionById,
} from "@/models";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";

const BASE_URL = "https://autoglm-api.autoglm.ai";
const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";

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

async function getUserProfile(accessToken) {
  if (!accessToken) {
    throw Object.assign(new Error("autoclaw: accessToken required"), { code: "INVALID_TOKEN" });
  }
  const token = accessToken.replace(/^Bearer\s+/i, "");
  const res = await fetch(`${BASE_URL}/userapi/v1/user-profile`, {
    method: "POST",
    headers: signHeaders({ "X-Authorization": `Bearer ${token}` }),
    body: "{}",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`autoclaw profile ${res.status} ${text}`);
    err.code = res.status === 401 || res.status === 403 ? "INVALID_TOKEN" : "PROFILE_FAILED";
    err.recoverable = res.status >= 500;
    throw err;
  }
  return res.json();
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const { accessToken, refreshToken, deviceId } = body;

  if (!accessToken || !refreshToken) {
    return NextResponse.json(
      { error: "accessToken and refreshToken are required" },
      { status: 400 }
    );
  }

  try {
    const device = deviceId || crypto.randomUUID();

    let profile;
    try {
      profile = await getUserProfile(accessToken);
    } catch (e) {
      return NextResponse.json(
        { error: `Invalid access_token: ${e.message}` },
        { status: 400 }
      );
    }

    const data = profile?.data || profile || {};
    const userId = data.user_id || data.userId || profile?.user_id;
    const userName = data.user_name || data.userName || profile?.user_name;

    const conn = await createProviderConnection({
      provider: "autoclaw",
      authType: "access_token",
      name: userName || String(userId || "autoclaw-import"),
      email: String(userId || "unknown"),
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      testStatus: "active",
      lastRefreshAt: new Date().toISOString(),
      providerSpecificData: {
        deviceId: device,
        userName,
        importedAt: new Date().toISOString(),
        refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });

    return NextResponse.json({ success: true, connection: { id: conn.id, name: conn.name, email: conn.email } });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
