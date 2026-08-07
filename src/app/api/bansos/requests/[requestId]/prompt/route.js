// Bansos Gateway admin API — manual prompt erasure for a single request.
// Task 12.
//
// eraseBansosPrompt(requestId) returns a bare boolean and, per its own
// implementation (`UPDATE ... WHERE requestId = ? AND prompt IS NOT NULL`),
// that boolean can't distinguish "requestId doesn't exist at all" from
// "requestId exists but its prompt was already erased/expired" — both leave
// zero rows changed. listBansosPromptAudits has no requestId filter (only
// userId/apiKeyId/status), so resolving that ambiguity precisely would mean
// an unbounded scan on every erase call just to pick between two 2xx-ish
// outcomes. Judgment call: treat `false` uniformly as 404. Prompt erasure
// is a deliberate, rare admin action; a double-erase attempt reasonably
// reads as "nothing left to erase" (not found), and an admin can always
// confirm current state via GET /api/bansos/requests before retrying.
import { NextResponse } from "next/server";
import { eraseBansosPrompt } from "@/lib/db/index.js";

// DELETE /api/bansos/requests/[requestId]/prompt
export async function DELETE(request, { params }) {
  try {
    const { requestId } = await params;
    const erased = await eraseBansosPrompt(requestId);
    if (!erased) {
      return NextResponse.json({ error: "Prompt not found or already erased" }, { status: 404 });
    }
    return NextResponse.json({ requestId, erased: true });
  } catch (error) {
    console.log("Error erasing Bansos prompt:", error);
    return NextResponse.json({ error: "Failed to erase prompt" }, { status: 500 });
  }
}
