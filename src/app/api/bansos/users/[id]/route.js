// Bansos Gateway admin API — get/update a single public-gateway user
// (activation, name, RPM, concurrency). Task 12.
import { NextResponse } from "next/server";
import { getBansosUserById, updateBansosUser } from "@/lib/db/index.js";
import { validatePositiveInt } from "@/lib/bansos/adminParams.js";

// GET /api/bansos/users/[id] - fetch a single user
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const user = await getBansosUserById(id);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    return NextResponse.json({ user });
  } catch (error) {
    console.log("Error fetching Bansos user:", error);
    return NextResponse.json({ error: "Failed to fetch user" }, { status: 500 });
  }
}

// PATCH /api/bansos/users/[id] - update name/RPM/concurrency/activation
export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));

    const patch = {};

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return NextResponse.json({ error: "name must be a non-empty string" }, { status: 400 });
      }
      patch.name = body.name;
    }

    if (body.requestsPerMinute !== undefined) {
      const err = validatePositiveInt(body.requestsPerMinute, "requestsPerMinute");
      if (err) return NextResponse.json({ error: err }, { status: 400 });
      patch.requestsPerMinute = Number(body.requestsPerMinute);
    }

    if (body.maxConcurrentRequests !== undefined) {
      const err = validatePositiveInt(body.maxConcurrentRequests, "maxConcurrentRequests");
      if (err) return NextResponse.json({ error: err }, { status: 400 });
      patch.maxConcurrentRequests = Number(body.maxConcurrentRequests);
    }

    if (body.isActive !== undefined) {
      patch.isActive = !!body.isActive;
    }

    const updated = await updateBansosUser(id, patch);
    if (!updated) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    return NextResponse.json({ user: updated });
  } catch (error) {
    console.log("Error updating Bansos user:", error);
    return NextResponse.json({ error: "Failed to update user" }, { status: 500 });
  }
}
