// Bansos Gateway admin API — list/create public-gateway users (Task 12).
// Local-only (see src/dashboardGuard.js LOCAL_ONLY_PATHS + deny-by-default
// /api/* auth). Pure composition over bansosRepo.js — no SQL/crypto here.
import { NextResponse } from "next/server";
import { createBansosUser, getSettings, listBansosUsers } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

function parseIntParam(value) {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

// >= 1 integer, or an explanatory error string.
function validatePositiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    return `${label} must be an integer >= 1`;
  }
  return null;
}

// GET /api/bansos/users - list Bansos gateway users (paginated)
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const filter = {};
    const page = parseIntParam(searchParams.get("page"));
    const pageSize = parseIntParam(searchParams.get("pageSize"));
    if (page !== undefined) filter.page = page;
    if (pageSize !== undefined) filter.pageSize = pageSize;

    const { users, pagination } = await listBansosUsers(filter);
    return NextResponse.json({ users, pagination });
  } catch (error) {
    console.log("Error listing Bansos users:", error);
    return NextResponse.json({ error: "Failed to list users" }, { status: 500 });
  }
}

// POST /api/bansos/users - create a Bansos gateway user
//
// requestsPerMinute/maxConcurrentRequests, when omitted, fall back to the
// admin-configured settings defaults (bansosDefaultRequestsPerMinute /
// bansosDefaultMaxConcurrentRequests — see /api/bansos/settings), and if
// those are also unset, to createBansosUser's own hardcoded 10/2 fallback —
// this route never hardcodes a default itself.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { name, isActive } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    let requestsPerMinute = body.requestsPerMinute;
    let maxConcurrentRequests = body.maxConcurrentRequests;

    if (requestsPerMinute !== undefined) {
      const err = validatePositiveInt(requestsPerMinute, "requestsPerMinute");
      if (err) return NextResponse.json({ error: err }, { status: 400 });
      requestsPerMinute = Number(requestsPerMinute);
    }
    if (maxConcurrentRequests !== undefined) {
      const err = validatePositiveInt(maxConcurrentRequests, "maxConcurrentRequests");
      if (err) return NextResponse.json({ error: err }, { status: 400 });
      maxConcurrentRequests = Number(maxConcurrentRequests);
    }

    if (requestsPerMinute === undefined || maxConcurrentRequests === undefined) {
      const settings = await getSettings();
      if (requestsPerMinute === undefined) requestsPerMinute = settings.bansosDefaultRequestsPerMinute;
      if (maxConcurrentRequests === undefined) maxConcurrentRequests = settings.bansosDefaultMaxConcurrentRequests;
    }

    const user = await createBansosUser({ name, requestsPerMinute, maxConcurrentRequests, isActive });
    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    console.log("Error creating Bansos user:", error);
    return NextResponse.json({ error: "Failed to create user" }, { status: 500 });
  }
}
