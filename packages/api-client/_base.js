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
 * Wraps fetch with the standard error-envelope handling shape described in
 * api-contracts.md §1. On a non-2xx response, throws an ApiClientError
 * carrying the parsed `{ error: { code, message, retryable } }` envelope so
 * callers (offline-queue retry logic) can branch on `retryable`.
 *
 * @param {string} path e.g. "/sales"
 * @param {RequestInit} init
 * @returns {Promise<any>} parsed JSON response body
 */
export async function apiFetch(path, init) {
  // TODO: attach `Authorization: Bearer <firebase-id-token>` header once
  //       auth wiring lands — see api-contracts.md §1.
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
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
