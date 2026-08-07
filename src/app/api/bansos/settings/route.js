// Bansos Gateway admin API — read-only policy constants + gateway
// enable/default-limit settings. Task 12.
//
// GET exposes both: compile-time constants from bansos/constants.js
// (hostname/models/retention/limits — never mutable) alongside the mutable
// settings-blob values (gateway kill switch + new-user limit defaults).
//
// PATCH enforces its own allowlist — updateSettings() itself has none (see
// settingsRepo.js) and would happily persist any key handed to it, so this
// route is the only thing standing between the request body and settings
// like `password` ever getting mass-assigned here.
//
// `bansosGatewayEnabled` is the existing emergency kill switch (checked in
// src/sse/handlers/chat.js as `settings.bansosGatewayEnabled === false`);
// absence means enabled, so there's no DEFAULT_SETTINGS entry for it —
// don't add one. `bansosDefaultRequestsPerMinute` /
// `bansosDefaultMaxConcurrentRequests` are new keys introduced by this task
// as the optional admin-configured fallback that /api/bansos/users' POST
// passes into createBansosUser when a caller omits per-user limits; they're
// also left out of DEFAULT_SETTINGS on purpose, so that "unset" defers all
// the way down to createBansosUser's own hardcoded 10/2 last-resort default
// rather than duplicating that default in two places.
import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/db/index.js";
import { BANSOS_HOST, BANSOS_LIMITS, INTERNAL_MODEL, PUBLIC_MODEL } from "@/lib/bansos/constants.js";

function toResponseShape(settings) {
  return {
    gatewayEnabled: settings.bansosGatewayEnabled !== false,
    defaultRequestsPerMinute: settings.bansosDefaultRequestsPerMinute,
    defaultMaxConcurrentRequests: settings.bansosDefaultMaxConcurrentRequests,
  };
}

// GET /api/bansos/settings
export async function GET() {
  try {
    const settings = await getSettings();
    return NextResponse.json({
      ...toResponseShape(settings),
      hostname: BANSOS_HOST,
      publicModel: PUBLIC_MODEL,
      internalModel: INTERNAL_MODEL,
      promptRetentionDays: BANSOS_LIMITS.promptRetentionDays,
      maxPromptSize: BANSOS_LIMITS.maxPromptSize,
      maxRequestBody: BANSOS_LIMITS.maxRequestBody,
      firstResponseTimeoutMs: BANSOS_LIMITS.firstResponseTimeoutMs,
      maxStreamDurationMs: BANSOS_LIMITS.maxStreamDurationMs,
    });
  } catch (error) {
    console.log("Error fetching Bansos settings:", error);
    return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
  }
}

// PATCH /api/bansos/settings - update only gateway enable / default-limit values
export async function PATCH(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const patch = {};

    if (Object.prototype.hasOwnProperty.call(body, "bansosGatewayEnabled")) {
      if (typeof body.bansosGatewayEnabled !== "boolean") {
        return NextResponse.json({ error: "bansosGatewayEnabled must be a boolean" }, { status: 400 });
      }
      patch.bansosGatewayEnabled = body.bansosGatewayEnabled;
    }

    if (Object.prototype.hasOwnProperty.call(body, "bansosDefaultRequestsPerMinute")) {
      const n = Number(body.bansosDefaultRequestsPerMinute);
      if (!Number.isInteger(n) || n < 1) {
        return NextResponse.json({ error: "bansosDefaultRequestsPerMinute must be an integer >= 1" }, { status: 400 });
      }
      patch.bansosDefaultRequestsPerMinute = n;
    }

    if (Object.prototype.hasOwnProperty.call(body, "bansosDefaultMaxConcurrentRequests")) {
      const n = Number(body.bansosDefaultMaxConcurrentRequests);
      if (!Number.isInteger(n) || n < 1) {
        return NextResponse.json({ error: "bansosDefaultMaxConcurrentRequests must be an integer >= 1" }, { status: 400 });
      }
      patch.bansosDefaultMaxConcurrentRequests = n;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "No valid settings fields provided" }, { status: 400 });
    }

    const updated = await updateSettings(patch);
    return NextResponse.json(toResponseShape(updated));
  } catch (error) {
    console.log("Error updating Bansos settings:", error);
    return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
  }
}
