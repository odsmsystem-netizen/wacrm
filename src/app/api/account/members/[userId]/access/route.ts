// ============================================================
// PUT /api/account/members/[userId]/access   — owner only
//
//   { "blocked": true }   — deny sign-in (reversible)
//   { "blocked": false }  — give access back
//
// Uses Supabase Auth's own ban (`ban_duration`), which blocks new sign-ins
// and token refreshes. Nothing is deleted: the member keeps their history
// and conversations. An already-open session stays valid until its access
// token expires. This is different from DELETE /members/[userId], which
// removes the member from the account.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAuthAdmin } from "@/lib/auth/admin-client";
import {
  BLOCK_DURATION,
  MemberTargetError,
  UNBLOCK_DURATION,
  loadTargetMember,
} from "@/lib/auth/member-access";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("owner");

    const limit = checkRateLimit(
      `admin:memberAccess:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { blocked?: unknown }
      | null;
    if (typeof body?.blocked !== "boolean") {
      return NextResponse.json(
        { error: "'blocked' must be true or false" },
        { status: 400 },
      );
    }
    const blocked = body.blocked;

    const { userId } = await params;
    const target = await loadTargetMember(ctx, userId);

    const { error } = await supabaseAuthAdmin().auth.admin.updateUserById(
      target.userId,
      { ban_duration: blocked ? BLOCK_DURATION : UNBLOCK_DURATION },
    );
    if (error) {
      console.error("[member access] updateUserById failed:", error.message);
      return NextResponse.json(
        { error: "Could not update the member's access" },
        { status: 502 },
      );
    }

    return NextResponse.json({ blocked });
  } catch (err) {
    if (err instanceof MemberTargetError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return toErrorResponse(err);
  }
}
