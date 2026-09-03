// ============================================================
// External agent presence.
//
// An account can hand inbound replies to an agent that runs outside
// wacrm: it receives `message.received` (or polls), decides, and answers
// through `POST /api/v1/messages`. wacrm never calls it, so there is
// nothing to store — its existence is a deployment fact, declared with
// one env var.
//
// The inbox needs to know because the per-thread "Take over" banner is
// otherwise gated on the *native* auto-reply being on. With an external
// agent the native bot is deliberately off, so without this the banner
// would never render and agents would lose the one control that stops
// a bot mid-conversation.
// ============================================================

/** Longest name we'll echo into the inbox banner. */
const MAX_NAME_LENGTH = 40

/**
 * The external agent's display name, or `null` when none is configured.
 *
 * One var carries both facts — whether an agent is there and what to
 * call it — because a nameless agent would still need a label in the
 * banner, and "AI assistant" is exactly the wrong one when the account
 * runs a named bot the team recognises.
 *
 * Read at call time rather than module load so a changed env var takes
 * effect on redeploy without a stale cached value.
 */
export function externalAgentName(): string | null {
  const raw = process.env.EXTERNAL_AGENT_NAME
  if (!raw) return null
  const name = raw.trim()
  // An empty or whitespace-only value means "not configured" — that's
  // what an unset var looks like in most deploy UIs, which write "".
  if (!name) return null
  return name.slice(0, MAX_NAME_LENGTH)
}
