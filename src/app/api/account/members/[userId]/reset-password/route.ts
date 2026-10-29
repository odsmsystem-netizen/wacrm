// ============================================================
// POST /api/account/members/[userId]/reset-password   — owner only
//
// Generates a one-time recovery link for a member and returns it to the
// owner, who hands it over in person / by WhatsApp. No email is sent —
// that is the point: Supabase's default SMTP doesn't reach most members.
// The member opens the link and chooses their own password; the owner
// never sees or sets it.
//
// The link is a credential: the response is `no-store` and neither the
// token nor the link is ever logged.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAuthAdmin } from "@/lib/auth/admin-client";
import {
  MemberTargetError,
  buildRecoveryLink,
  loadTargetMember,
} from "@/lib/auth/member-access";
import { requestOrigin } from "@/lib/http/request-origin";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("owner");

    const limit = checkRateLimit(
      `admin:memberReset:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;
    const target = await loadTargetMember(ctx, userId);

    const admin = supabaseAuthAdmin();

    // The email on the auth user is the one Supabase will match; don't
    // trust the (editable) profile copy.
    const { data: authUser } = await admin.auth.admin.getUserById(target.userId);
    const email = authUser?.user?.email;
    if (!email) {
      return NextResponse.json(
        { error: "This member has no email on file" },
        { status: 400 },
      );
    }

    const { data, error } = await admin.auth.admin.generateLink({
      type: "recovery",
      email,
    });
    const token = data?.properties?.hashed_token;
    if (error || !token) {
      // Log the failure class only: `error.message` could echo the token.
      console.error(
        "[reset-password] generateLink failed:",
        error ? "supabase error" : "no hashed_token in response",
      );
      return NextResponse.json(
        { error: "Could not generate the recovery link" },
        { status: 502 },
      );
    }

    return NextResponse.json(
      { link: buildRecoveryLink(requestOrigin(request), token) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof MemberTargetError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return toErrorResponse(err);
  }
}
