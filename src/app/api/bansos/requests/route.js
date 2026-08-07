// Bansos Gateway admin API — paginated, filterable prompt-audit ("Requests")
// list. Task 12. Pure passthrough to listBansosPromptAudits; only sets
// filter keys that were actually supplied so an omitted query param doesn't
// turn into an empty-string filter downstream.
import { NextResponse } from "next/server";
import { listBansosPromptAudits } from "@/lib/db/index.js";

function parseIntParam(value) {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

// GET /api/bansos/requests?userId=&apiKeyId=&status=&page=&pageSize=
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const filter = {};

    const userId = searchParams.get("userId");
    const apiKeyId = searchParams.get("apiKeyId");
    const status = searchParams.get("status");
    if (userId) filter.userId = userId;
    if (apiKeyId) filter.apiKeyId = apiKeyId;
    if (status) filter.status = status;

    const page = parseIntParam(searchParams.get("page"));
    const pageSize = parseIntParam(searchParams.get("pageSize"));
    if (page !== undefined) filter.page = page;
    if (pageSize !== undefined) filter.pageSize = pageSize;

    const { audits, pagination } = await listBansosPromptAudits(filter);
    return NextResponse.json({ audits, pagination });
  } catch (error) {
    console.log("Error listing Bansos requests:", error);
    return NextResponse.json({ error: "Failed to list requests" }, { status: 500 });
  }
}
