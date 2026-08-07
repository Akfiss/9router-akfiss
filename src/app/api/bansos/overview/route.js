// Bansos Gateway admin API — dashboard overview: user/key/request counts,
// limiter snapshot, today's attributed usage, Grok CLI connection presence,
// and (only when explicitly requested) public-host reachability. Task 12.
//
// Global usage aggregation: today's usage total comes from ONE call to
// bansosRepo.js's getBansosUsageTotalsAcrossUsers — a single-pass scan over
// usageHistory that sums every row across ALL Bansos users at once. This
// route used to sum getBansosUsageBreakdown(userId, {startDate}) once per
// user instead; that function does its own full, unindexed `usageHistory`
// scan per call (JS-side meta filtering, for sql.js-adapter portability —
// see bansosRepo.js), and every DB adapter here runs synchronously, so N
// per-user calls meant N blocking scans back-to-back on Node's single event
// loop — stalling every other in-flight request (including live SSE
// streams) for that duration on every load of this endpoint (which Task 13
// polls from a live dashboard). getBansosUsageTotalsAcrossUsers only returns
// the summed totalRequests/totalPromptTokens/totalCompletionTokens/
// totalCost this card needs — no byModel/byApiKey breakdown, since this
// route would discard that anyway.
//
// keyCount aggregation is unchanged: page through listBansosUsers and, for
// each user, sum listBansosKeysByUser's pagination.totalItems. That's still
// O(users) calls, but each is a normal indexed-ish per-user lookup
// (`WHERE userId = ?`), not a full-table scan, so it doesn't have the same
// blocking-scan problem the usage aggregation had.
import { NextResponse } from "next/server";
import {
  getBansosUsageTotalsAcrossUsers,
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

// Pages through every Bansos user once, summing each one's key count (a
// per-user lookup, not a full-table scan — see file header). Today's usage
// total is fetched separately, in one single-pass call to
// getBansosUsageTotalsAcrossUsers — see file header for why that's no
// longer summed per user inside this loop.
async function aggregateAcrossUsers() {
  const startDate = startOfTodayIso();
  let keyCount = 0;

  let page = 1;
  for (;;) {
    const { users, pagination } = await listBansosUsers({ page, pageSize: AGGREGATE_PAGE_SIZE });
    for (const user of users) {
      const keysPage = await listBansosKeysByUser(user.id, { pageSize: 1 });
      keyCount += keysPage.pagination.totalItems;
    }
    if (!pagination.hasNext) break;
    page += 1;
  }

  const todayUsage = await getBansosUsageTotalsAcrossUsers({ startDate });

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
