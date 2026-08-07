// Bansos Gateway admin API — dashboard overview: user/key/request counts,
// limiter snapshot, today's attributed usage, Grok CLI connection presence,
// and (only when explicitly requested) public-host reachability. Task 12.
//
// Global usage/key aggregation: bansosRepo.js exposes getBansosUsageBreakdown
// scoped to a single userId (it throws without one) and no global
// "all users" aggregate — see the repo file's own "Usage breakdown" comment
// on why that aggregation stays in JS rather than SQL JSON1 (adapter
// portability to sql.js). Rather than add a new repo primitive for a single
// admin-only overview card, this route composes the existing per-user
// functions: page through listBansosUsers and, for each user, sum
// listBansosKeysByUser's pagination.totalItems (key count) and
// getBansosUsageBreakdown's totals (today's usage). This keeps bansosRepo's
// surface unchanged and matches this task's "composition, not new business
// logic" brief. Acceptable at the expected scale of an admin-managed
// Bansos user roster (tens, not millions); revisit with a real SQL
// aggregate if that stops being true.
import { NextResponse } from "next/server";
import {
  getBansosUsageBreakdown,
  getProviderConnections,
  listBansosKeysByUser,
  listBansosPromptAudits,
  listBansosUsers,
} from "@/lib/db/index.js";
import { getBansosLimiterSnapshot } from "@/lib/bansos/rateLimiter.js";
import { BANSOS_HOST } from "@/lib/bansos/constants.js";

// Mirrors the "bounded health probe" idiom in
// src/lib/tunnel/cloudflare/healthCheck.js (fetchTimeoutMs: 5000) — short
// enough that an admin waiting on this card doesn't hang, generous enough
// not to false-negative on a slow-but-alive host.
const PROBE_TIMEOUT_MS = 5000;

const AGGREGATE_PAGE_SIZE = 100;

function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// Pages through every Bansos user once, summing each one's key count and
// today's usage breakdown. Composition-only — no SQL, no new repo surface.
async function aggregateAcrossUsers() {
  const startDate = startOfTodayIso();
  let keyCount = 0;
  const todayUsage = { totalRequests: 0, totalPromptTokens: 0, totalCompletionTokens: 0, totalCost: 0 };

  let page = 1;
  for (;;) {
    const { users, pagination } = await listBansosUsers({ page, pageSize: AGGREGATE_PAGE_SIZE });
    for (const user of users) {
      const keysPage = await listBansosKeysByUser(user.id, { pageSize: 1 });
      keyCount += keysPage.pagination.totalItems;

      const breakdown = await getBansosUsageBreakdown(user.id, { startDate });
      todayUsage.totalRequests += breakdown.totalRequests;
      todayUsage.totalPromptTokens += breakdown.totalPromptTokens;
      todayUsage.totalCompletionTokens += breakdown.totalCompletionTokens;
      todayUsage.totalCost += breakdown.totalCost;
    }
    if (!pagination.hasNext) break;
    page += 1;
  }

  return { keyCount, todayUsage };
}

// Pure fetch probe — no tunnel/cloudflared credential or process management
// here (out of scope for this MVP per the brief). Never throws: any failure
// (timeout, DNS, network error, non-2xx) collapses to reachable:false.
async function probeBansosPublicHost() {
  const url = `https://${BANSOS_HOST}/v1/models`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return { reachable: res.ok, status: res.status };
  } catch (error) {
    return { reachable: false, error: error?.message || "probe failed" };
  }
}

// GET /api/bansos/overview[?probe=true]
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const shouldProbe = searchParams.get("probe") === "true";

    const [{ pagination: usersPagination }, { pagination: requestsPagination }, grokConnections, { keyCount, todayUsage }] =
      await Promise.all([
        listBansosUsers({ pageSize: 1 }),
        listBansosPromptAudits({ pageSize: 1 }),
        getProviderConnections({ provider: "grok-cli", isActive: true }),
        aggregateAcrossUsers(),
      ]);

    const overview = {
      userCount: usersPagination.totalItems,
      keyCount,
      requestCount: requestsPagination.totalItems,
      limiterSnapshot: getBansosLimiterSnapshot(),
      todayUsage,
      grokCliConnected: grokConnections.length > 0,
      grokCliConnectionCount: grokConnections.length,
    };

    if (shouldProbe) {
      overview.publicHost = await probeBansosPublicHost();
    }

    return NextResponse.json(overview);
  } catch (error) {
    console.log("Error building Bansos overview:", error);
    return NextResponse.json({ error: "Failed to build overview" }, { status: 500 });
  }
}
