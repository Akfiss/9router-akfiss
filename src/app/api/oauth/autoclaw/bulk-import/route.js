import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const { accounts } = body;

  if (!Array.isArray(accounts) || accounts.length === 0) {
    return NextResponse.json(
      { error: "accounts array is required (each: { email, access_token, refresh_token, device_id })" },
      { status: 400 }
    );
  }

  const results = [];
  let success = 0;
  let failed = 0;

  for (const acct of accounts) {
    const accessToken = acct.access_token || acct.accessToken;
    const refreshToken = acct.refresh_token || acct.refreshToken;
    const deviceId = acct.device_id || acct.deviceId || crypto.randomUUID();
    const email = acct.email || `autoclaw-${Date.now()}-${failed + success}`;

    if (!accessToken || !refreshToken) {
      results.push({ email, status: "failed", error: "missing tokens" });
      failed++;
      continue;
    }

    try {
      const conn = await createProviderConnection({
        provider: "autoclaw",
        authType: "access_token",
        name: email,
        email,
        accessToken,
        refreshToken,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        testStatus: "active",
        lastRefreshAt: new Date().toISOString(),
        providerSpecificData: {
          deviceId,
          importedAt: new Date().toISOString(),
          refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });
      results.push({ email, status: "success", connectionId: conn.id });
      success++;
    } catch (e) {
      results.push({ email, status: "failed", error: e.message });
      failed++;
    }
  }

  return NextResponse.json({ success, failed, results });
}
