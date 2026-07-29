/**
 * Connection-state classification.
 *
 * Deliberately free of `server-only` and of any I/O so it can be unit-tested
 * directly and imported from both the API routes and the client types.
 */

export type ConnReason = 'ok' | 'unconfigured' | 'rejected' | 'unreachable';

/** The env vars the app cannot talk to JIRA without, in the order we report them. */
export const CRED_VARS = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'] as const;

export type CredVar = (typeof CRED_VARS)[number];

/** Values shipped in .env.example — present in the file but not actually filled in. */
const PLACEHOLDERS = new Set([
  'paste-your-token-here',
  'https://your-org.atlassian.net',
  'you@example.com',
]);

/**
 * Which credential vars are effectively unset: absent, blank, or still holding
 * the placeholder from .env.example. Copying the example file and filling in
 * only some fields is the most common setup mistake, and it should read as
 * "not configured yet" rather than as a credential rejection.
 */
export function missingCreds(env: Record<string, string | undefined>): CredVar[] {
  return CRED_VARS.filter((v) => {
    const value = env[v]?.trim();
    return !value || PLACEHOLDERS.has(value);
  });
}

/** Map an HTTP status (0 for a thrown fetch) onto a connection reason. */
export function reasonForStatus(status: number): ConnReason {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'rejected';
  return 'unreachable';
}

/** Shape returned by GET /api/me. Shared by the route and the client. */
export interface MyselfResult {
  ok: boolean;
  status: number;
  reason: ConnReason;
  /** Env var NAMES that are unset. Never contains values. */
  missing: CredVar[];
  /** Non-secret base URL, echoed back so the setup screen can prefill it. */
  baseUrl: string | null;
  /** True when `next dev` is running, which reloads .env.local without a restart. */
  devMode: boolean;
  /**
   * Activity labels from JIRA_ACTIVITIES. Empty means the feature is off and Pause
   * behaves as it did before activities existed. Config rather than connection
   * state, but this is the one endpoint the client already polls.
   */
  activities: string[];
  name?: string;
  email?: string;
  error?: string;
}
