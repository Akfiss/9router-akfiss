// Bansos Gateway admin API — list/create API keys for a given public-gateway
// user. Task 12. Plaintext appears only in the create response (once); the
// underlying keyService.createBansosKey result also carries keyHash, which
// this route strips before responding — it must never leave the process.
import { NextResponse } from "next/server";
import { getBansosUserById, listBansosKeysByUser } from "@/lib/db/index.js";
import { createBansosKey } from "@/lib/bansos/keyService.js";

function parseIntParam(value) {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

// GET /api/bansos/users/[id]/keys - list a user's keys (paginated)
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const user = await getBansosUserById(id);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const filter = {};
    const page = parseIntParam(searchParams.get("page"));
    const pageSize = parseIntParam(searchParams.get("pageSize"));
    if (page !== undefined) filter.page = page;
    if (pageSize !== undefined) filter.pageSize = pageSize;

    const { keys, pagination } = await listBansosKeysByUser(id, filter);
    return NextResponse.json({ keys, pagination });
  } catch (error) {
    console.log("Error listing Bansos keys:", error);
    return NextResponse.json({ error: "Failed to list keys" }, { status: 500 });
  }
}

// POST /api/bansos/users/[id]/keys - create a new key for the user
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const user = await getBansosUserById(id);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const { name } = body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const created = await createBansosKey({ userId: id, name });
    const { keyHash, ...safeKey } = created; // never forward the hash
    return NextResponse.json({ key: safeKey }, { status: 201 });
  } catch (error) {
    console.log("Error creating Bansos key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
