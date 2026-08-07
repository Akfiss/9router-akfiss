// Bansos Gateway admin API — revoke/rotate a single API key by id.
// Task 12.
//
// Both operations are ownership-scoped in the repo/service layer
// (revokeBansosKey(id, userId), rotateBansosKey({keyId, userId, ...})) —
// there is deliberately no getBansosKeyById (see bansosRepo.js), so the
// caller (the admin dashboard, which already scopes its key list by user —
// see /api/bansos/users/[id]/keys) must supply userId itself: as a query
// param on DELETE (bodyless-by-convention), and in the JSON body on POST
// (which already needs a body for the optional new `name`).
//
// DELETE is the revoke action: revokeBansosKey is an idempotent no-op on an
// already-revoked key (returns the row unchanged, 200) — see bansosRepo.js's
// own header comment — so this route never needs a 409 for that case.
//
// POST is the rotate action: rotateBansosKey *throws*
// "Bansos key not found for this user" (not a null return) when the key
// doesn't exist or isn't owned by that user — caught here and mapped to 404
// specifically, so a genuine bug elsewhere still surfaces as 500.
import { NextResponse } from "next/server";
import { revokeBansosKey } from "@/lib/db/index.js";
import { rotateBansosKey } from "@/lib/bansos/keyService.js";

const KEY_NOT_FOUND_MESSAGE = "Bansos key not found for this user";

// DELETE /api/bansos/keys/[id]?userId=... - revoke
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const key = await revokeBansosKey(id, userId);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error revoking Bansos key:", error);
    return NextResponse.json({ error: "Failed to revoke key" }, { status: 500 });
  }
}

// POST /api/bansos/keys/[id] - rotate (body: { userId, name? })
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const { userId, name } = body;
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    let rotated;
    try {
      rotated = await rotateBansosKey({ keyId: id, userId, name });
    } catch (err) {
      if (err instanceof Error && err.message === KEY_NOT_FOUND_MESSAGE) {
        return NextResponse.json({ error: "Key not found" }, { status: 404 });
      }
      throw err;
    }

    const { keyHash, ...safeKey } = rotated; // never forward the hash
    return NextResponse.json({ key: safeKey });
  } catch (error) {
    console.log("Error rotating Bansos key:", error);
    return NextResponse.json({ error: "Failed to rotate key" }, { status: 500 });
  }
}
