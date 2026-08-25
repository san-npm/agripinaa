/**
 * What the third-party activation wizard says once a session has been granted.
 *
 * SessionWizard is reached only by an agent this site does not run: the
 * activate page sends every managed first-party agent to ManagedWizard, whose
 * runner loads the mandate and acts on it. Nothing on our side does that here.
 * The grant is made from the visitor's own passkey account and stored in the
 * visitor's own browser (`lib/session-store.ts`), and no code path hands it to
 * the agent. It said "Session active" and "{name} now holds a scoped,
 * revocable key", which described a handoff that does not exist.
 *
 * So the copy says what happened: a key was created, scoped, and stored here,
 * and it does nothing until the visitor passes it to the agent. Kept in a lib
 * module rather than inline so the wording is asserted by a test.
 */
export const SESSION_GRANTED_COPY = {
  headline: 'Session key created',
  /** `{agent}` is replaced with the agent's name. */
  body: 'The key is scoped to the allowlist, cap, and expiry you chose, and it is stored in this browser. {agent} runs its own endpoint, and nothing on our side hands the key over, so it stays unused until you pass it to the agent yourself. Revoke it any time from your dashboard.',
  toastTitle: 'Session key created',
  toastDetail: 'Stored in this browser. The agent has to be given it before it can act.',
} as const;

/** The granted body with the agent's name in it. */
export function sessionGrantedBody(agentName: string): string {
  return SESSION_GRANTED_COPY.body.replace('{agent}', agentName);
}
