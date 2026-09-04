/**
 * Shared plumbing for the thin fetch wrappers in this package. Not exported
 * from the package's public surface — salesApi/stockApi/expensesApi each
 * import from here directly.
 *
 * Every mutation in this app is a POST to the FastAPI backend described in
 * ultimate-bookkeeping-v2-api-contracts.md — the outlet app never writes to
 * Postgres/Firestore directly (CLAUDE.md non-negotiable constraint).
 */

/** Base path for all v1 endpoints, per api-contracts.md §1. */
export const API_BASE = "/api/v1";

/**
 * Injected async function returning the current Firebase ID token (or
 * null/undefined if there isn't one). Defaults to a no-token provider so
 * this package works standalone (e.g. in tests) with no Authorization
 * header attached — @ub/api-client deliberately has no Firebase import of
 * its own (see api-contracts.md §1 + the auth wiring notes in
 * apps/outlet/src/auth/AuthContext.jsx): the dependency points inward, auth
 * registers itself here rather than this package reaching out to auth.
 *
 * @type {() => Promise<string|null|undefined>}
 */
let tokenProvider = async () => null;

/**
 * Registers the function apiFetch calls to obtain the current ID token.
 * AuthProvider calls this once with `() => user.getIdToken()` on sign-in
 * (and again with a no-token provider on sign-out) — Firebase's SDK already
 * handles refresh, so this package just asks for "the token, right now" on
 * every request, including offline-queue's replayed requests.
 *
 * @param {() => Promise<string|null|undefined>} fn
 */
export function setTokenProvider(fn) {
  tokenProvider = typeof fn === "function" ? fn : async () => null;
}

/**
 * Wraps fetch with the standard error-envelope handling shape described in
 * api-contracts.md §1. On a non-2xx response, throws an ApiClientError
 * carrying the parsed `{ error: { code, message, retryable } }` envelope so
 * callers (offline-queue retry logic) can branch on `retryable`.
 *
 * Attaches `Authorization: Bearer <token>` when the registered token
 * provider returns a token (per api-contracts.md §1); omits the header
 * entirely when it doesn't, rather than sending an empty/undefined value.
 *
 * @param {string} path e.g. "/sales"
 * @param {RequestInit} init
 * @returns {Promise<any>} parsed JSON response body
 */
export async function apiFetch(path, init) {
  const token = await tokenProvider();

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init && init.headers),
    },
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const envelope = body && body.error
      ? body.error
      : { code: "UNKNOWN_ERROR", message: "Request failed", retryable: false };
    throw new ApiClientError(envelope, res.status);
  }

  return body;
}

/** Error thrown by apiFetch for any non-2xx response. */
export class ApiClientError extends Error {
  /**
   * @param {{code: string, message: string, retryable: boolean}} envelope
   * @param {number} status
   */
  constructor(envelope, status) {
    super(envelope.message);
    this.name = "ApiClientError";
    this.code = envelope.code;
    this.retryable = envelope.retryable;
    this.status = status;
  }
}
