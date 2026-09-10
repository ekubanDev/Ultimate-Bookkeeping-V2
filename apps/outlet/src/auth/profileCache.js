/**
 * profileCache — last-known-good `/me` profile, persisted locally so a
 * legitimately signed-in cashier isn't locked out of the app by an
 * offline relaunch (see AuthContext.jsx's deriveAuthState for the fix this
 * supports).
 *
 * IMPORTANT — what this is and isn't:
 *   - This is a UX-continuity cache, never an authorization decision. It
 *     lets the UI keep working (show a name, let a sale be queued) while
 *     `/me` can't be reached. It grants nothing: every mutation still goes
 *     through @ub/api-client with a freshly-fetched Firebase ID token (see
 *     AuthContext.jsx's token-provider wiring), and the backend resolves
 *     `outlet_id` for an `outlet_manager` from the verified auth context
 *     server-side, never from client-supplied/cached data (see
 *     apps/api/app/authz.py's `resolve_authorized_outlet`) — so a stale
 *     cached `outlet_id` can't be used to write into another outlet even if
 *     this cache is stale or tampered with.
 *   - Never cache anything credential-shaped (no tokens) — only the plain
 *     `/me` response body (id/role/outlet_id/display_name).
 *   - Keyed by Firebase uid so a device shared across shifts never hands
 *     Staff B a cached profile belonging to Staff A just because Staff A
 *     signed in earlier; each uid gets its own slot.
 *
 * Guarded with try/catch throughout: localStorage can throw (Safari private
 * mode, storage quota, disabled storage) and none of that should ever be
 * able to crash auth bootstrapping — a cache miss/write failure just means
 * we fall back to the non-cached behavior.
 */

const KEY_PREFIX = "ub-outlet:last-profile:";

function storage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Persists the most recent successful `/me` response for this Firebase uid.
 * Call this every time `/me` succeeds — last-write-wins, no merging.
 *
 * @param {string} uid
 * @param {object} profile the parsed `/me` response body
 */
export function cacheProfile(uid, profile) {
  const s = storage();
  if (!s || !uid || !profile) return;
  try {
    s.setItem(KEY_PREFIX + uid, JSON.stringify({ profile, cachedAt: Date.now() }));
  } catch {
    // Storage full/unavailable — degrade to "no cache", never throw.
  }
}

/**
 * Reads back the last cached profile for this Firebase uid, or null if
 * there isn't one (never signed in successfully on this device before, or
 * storage unavailable/corrupt).
 *
 * @param {string} uid
 * @returns {{ profile: object, cachedAt: number } | null}
 */
export function readCachedProfile(uid) {
  const s = storage();
  if (!s || !uid) return null;
  try {
    const raw = s.getItem(KEY_PREFIX + uid);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.profile) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Clears the cached profile for a uid (e.g. on explicit sign-out, so a
 * later different account signing in on the same device never sees a
 * previous cashier's cached profile as a fallback).
 *
 * @param {string} uid
 */
export function clearCachedProfile(uid) {
  const s = storage();
  if (!s || !uid) return;
  try {
    s.removeItem(KEY_PREFIX + uid);
  } catch {
    // ignore
  }
}
