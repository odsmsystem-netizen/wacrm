import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for auth admin calls (generateLink,
// updateUserById, getUserById). Same shape as src/lib/flows/admin-client.ts
// and src/lib/automations/admin-client.ts.
//
// Server-only: the service-role key bypasses RLS and must never reach a
// client bundle. Every caller goes through `requireRole('owner')` first.
let _adminClient: SupabaseClient | null = null

export function supabaseAuthAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    )
  }
  return _adminClient
}
