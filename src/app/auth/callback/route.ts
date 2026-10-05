import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Landing point for the links Supabase emails (password reset). It trades
// the one-time `code` for a session cookie, then forwards to `next`.
//
// Behind the Dokploy proxy `request.url` carries the container's internal
// host, so the redirect target is rebuilt from the forwarded host instead.

function safeNext(raw: string | null): string {
  // Only same-site paths: "//evil.com" and "/\evil.com" are protocol-relative
  // in browsers and would turn this into an open redirect.
  if (raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) {
    return raw;
  }
  return "/dashboard";
}

function originOf(request: NextRequest): string {
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host")?.trim();
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    request.nextUrl.protocol.replace(":", "");
  return host ? `${proto}://${host}` : request.nextUrl.origin;
}

export async function GET(request: NextRequest) {
  const origin = originOf(request);
  const code = request.nextUrl.searchParams.get("code");
  const next = safeNext(request.nextUrl.searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Expired / already used link, or opened in a different browser than the
  // one that requested it (the PKCE verifier lives in that browser's cookies).
  return NextResponse.redirect(`${origin}/forgot-password`);
}
