import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getMe, setTokenProvider, ApiClientError } from "@ub/api-client";
import { setCurrentUserProvider, flush } from "@ub/offline-queue";
import { loadFirebaseAuth, isFirebaseConfigured } from "./firebase.js";
import { cacheProfile, readCachedProfile, clearCachedProfile } from "./profileCache.js";

/**
 * AuthContext — the single source of truth for "who is signed in, and what
 * does the backend say about them" for the whole Outlet app.
 *
 * Status machine (per the task brief):
 *   'unconfigured'        — VITE_FIREBASE_* env vars absent; SDK never touched.
 *   'loading'             — Firebase's onAuthStateChanged hasn't fired yet, or
 *                           a Firebase user exists and /me is in flight (with
 *                           no usable cached profile to fall back on yet).
 *   'signed_out'          — no Firebase user, OR a Firebase user exists but
 *                           /me came back with a confirmed rejection (a real
 *                           HTTP response, not a network failure) and there's
 *                           no cached profile to degrade into.
 *   'signed_in'           — Firebase user + /me both resolved successfully.
 *   'signed_in_degraded'  — Firebase user exists, /me could not be reached
 *                           (network failure — see deriveAuthState below),
 *                           but a previously-cached profile for this uid
 *                           exists, so the app boots into a working-but-stale
 *                           state rather than locking the cashier out. See
 *                           "OFFLINE-RELAUNCH LOCKOUT FIX" below.
 *   'unprovisioned'        — Firebase user exists, but /me returned
 *                           USER_NOT_PROVISIONED (403) — the account has no
 *                           corresponding `users` row yet.
 *
 * OFFLINE-RELAUNCH LOCKOUT FIX (Kojo, 2026-09 — Adjoa QA bug #1): this app's
 * entire reason for existing is "a sale can never fail to record", including
 * right after a crash/force-quit/low-memory kill on a cheap Android device —
 * routine on this hardware. Before this fix, ANY /me failure (including a
 * plain network error, which is exactly what happens when Firebase restores
 * a session on relaunch while offline) collapsed to 'signed_out', dropping a
 * legitimately signed-in cashier at LoginScreen — which they also can't use
 * offline. That's total lockout in exactly the conditions this product
 * exists for.
 *
 * The fix distinguishes "confirmed signed out / rejected" (a real HTTP
 * response from /me — see meResultFromError: an ApiClientError has a
 * `code`) from "don't know — /me couldn't be reached at all" (no `code`:
 * `fetch` itself rejected, e.g. offline/DNS/timeout). Only the latter, when
 * we have a locally-cached last-known-good profile for this Firebase uid
 * (persisted via profileCache.js every time /me previously succeeded),
 * degrades into 'signed_in_degraded' instead of 'signed_out'. This is a UX
 * continuity aid ONLY, never an authorization decision:
 *   - No token is ever cached — @ub/api-client's token provider still calls
 *     `firebaseUser.getIdToken()` fresh at every dispatch (see the
 *     useEffect below), cached-profile or not.
 *   - A stale cached `outlet_id` can't be used to write into another outlet
 *     even if this cache were tampered with: the backend resolves
 *     `outlet_id` for an `outlet_manager` from the verified auth context
 *     server-side and ignores any client-supplied value (see
 *     apps/api/app/authz.py's `resolve_authorized_outlet`, verified
 *     directly against the routers that call it).
 *   - It's never silent: App.jsx surfaces 'signed_in_degraded' with a
 *     visible "working from your last signed-in account details" banner
 *     rather than pretending everything is normal.
 *
 * Owns: the onAuthStateChanged effect, calling /me, registering the
 * api-client token provider. Derivation of "given a firebase user + a /me
 * result (or error), what's the resulting status/profile" is pulled out
 * into pure, exported functions below per tesseract-fp-guide.md §4 — this
 * component's job is wiring effects to state, not deciding what the state
 * means.
 *
 * BUNDLE-SIZE / OFFLINE-SAFETY NOTE (Kojo, 2026-09): the Firebase Auth SDK
 * (`firebase/app` + `firebase/auth`) is loaded lazily via
 * `firebase.js`'s `loadFirebaseAuth()` instead of a static import, because
 * it's ~34% of the app's minified bundle on its own. This is safe to defer
 * WITHOUT trading away offline guarantees or perceived first paint, for
 * two reasons:
 *   1. The very first thing a user sees is `status === 'loading'`
 *      (App.jsx's plain "Loading..." splash) or 'unconfigured' — neither
 *      needs the SDK loaded. 'unconfigured' in particular is decided by
 *      `isFirebaseConfigured`, a synchronous env-var check with zero SDK
 *      involvement, so that path is actually now FASTER (doesn't wait on
 *      parsing 150KB of Firebase it was never going to use).
 *   2. The effect below calls loadFirebaseAuth() unconditionally, the
 *      moment AuthProvider mounts — i.e. at the same point in app startup
 *      the SDK would have been forced to load before, just as its own
 *      parallel request instead of baked into the monolithic bundle. A
 *      session that's online when the app boots is online for this fetch
 *      too; it does not introduce a new "loaded once, needed again later
 *      while offline" gap the way lazily-loading a whole SCREEN behind
 *      React.lazy would (see App.jsx for why Stock/Expenses are NOT
 *      lazy-split — those are the two offline-write screens per CLAUDE.md,
 *      and this repo has no service worker/PWA caching yet to guarantee a
 *      later on-demand chunk fetch succeeds offline).
 * signIn()/signOut() also call loadFirebaseAuth(), but by the time a user
 * can reach LoginScreen or trigger signOut, the mount-time call above has
 * already resolved (or is resolving) — they just await the same memoized
 * promise, so this isn't a second cold fetch on the interaction path.
 */
const AuthContext = createContext(null);

/**
 * deriveAuthState — pure. Given the outcome of fetching /me for a signed-in
 * Firebase user (and, optionally, a locally-cached last-known-good profile
 * for that same uid — see profileCache.js), decides the resulting
 * {status, profile, error}. Kept separate from the async /me call itself so
 * it's unit-testable with plain objects, no mocking required.
 *
 * The key distinction (see the OFFLINE-RELAUNCH LOCKOUT FIX note above):
 *   - `meResult.code` present            -> a real HTTP response came back
 *                                            from /me. A confirmed rejection
 *                                            (USER_NOT_PROVISIONED, or
 *                                            anything else) is decisive —
 *                                            never overridden by a cache.
 *   - `meResult.code` absent, `ok: false` -> /me could not be reached at all
 *                                            (network failure — see
 *                                            meResultFromError). We do NOT
 *                                            know the account is invalid; if
 *                                            `cachedProfile` is available,
 *                                            degrade rather than lock out.
 *
 * @param {{ ok: true, profile: object } | { ok: false, code?: string, message?: string }} meResult
 * @param {object|null} [cachedProfile] last-known-good `/me` response for
 *   this uid, from profileCache.readCachedProfile(uid)?.profile — only
 *   consulted when meResult is a network-failure-shaped rejection (no code).
 * @returns {{ status: 'signed_in'|'signed_in_degraded'|'unprovisioned'|'signed_out', profile: object|null, error: string|null }}
 */
export function deriveAuthState(meResult, cachedProfile = null) {
  if (meResult.ok) {
    return { status: "signed_in", profile: meResult.profile, error: null };
  }

  if (meResult.code === "USER_NOT_PROVISIONED") {
    return {
      status: "unprovisioned",
      profile: null,
      error: "Your account isn't set up yet — ask your admin to set up your account.",
    };
  }

  if (meResult.code) {
    // A real, decisive rejection from the server (401 stale token rejected,
    // 500 the server itself is broken, etc.) — we WERE able to reach it, so
    // a cached profile never overrides this. Matches pre-fix behavior.
    return {
      status: "signed_out",
      profile: null,
      error: meResult.message || "Could not load your account. Please try signing in again.",
    };
  }

  if (cachedProfile) {
    // No `code` means /me itself couldn't be reached (network error/offline)
    // — not a confirmed rejection. A Firebase session was restored, so boot
    // into a degraded-but-working state on the last-known profile instead of
    // dropping a legitimately signed-in cashier at a LoginScreen they also
    // can't use offline.
    return {
      status: "signed_in_degraded",
      profile: cachedProfile,
      error:
        "You're offline — working from your last signed-in account details. Some info may be out of date until you reconnect.",
    };
  }

  return {
    status: "signed_out",
    profile: null,
    error: meResult.message || "Could not load your account. Please try signing in again.",
  };
}

/**
 * meResultFromError — pure. Normalizes whatever getMe() throws into the
 * plain {ok:false, code, message} shape deriveAuthState expects, so the
 * effect below stays a thin try/catch around one call.
 *
 * @param {unknown} err
 * @returns {{ ok: false, code?: string, message?: string }}
 */
export function meResultFromError(err) {
  if (err instanceof ApiClientError) {
    return { ok: false, code: err.code, message: err.message };
  }
  return { ok: false, message: (err && err.message) || "Network error" };
}

export function AuthProvider({ children }) {
  const [firebaseUser, setFirebaseUser] = useState(undefined); // undefined = not-yet-known
  const [state, setState] = useState({ status: "loading", profile: null, error: null });

  // Registers/deregisters the api-client token provider whenever the
  // Firebase user changes — this is the ONLY place @ub/api-client learns
  // about auth; the package itself has no Firebase import (task brief §3 /
  // tesseract-fp-guide.md §2: side effects pushed to the edges). Firebase's
  // SDK handles token refresh internally, so `() => user.getIdToken()`
  // always returns a current token, including for offline-queue's
  // replayed requests.
  useEffect(() => {
    if (firebaseUser) {
      setTokenProvider(() => firebaseUser.getIdToken());
    } else {
      setTokenProvider(() => Promise.resolve(null));
    }
  }, [firebaseUser]);

  // Binds the acting user's id into @ub/offline-queue for its
  // identity-mismatch check (Nana's security-review finding) — this is
  // identity for attribution/consent, NOT a credential: no token is ever
  // read or persisted here, only `profile.id` (users.id / Firebase UID).
  // Registered off `state.profile` rather than `firebaseUser` because
  // that's the id offline-queue entries are bound to (useSubmitSale.js et
  // al. use `profile.id`, since it's `/me`'s answer, not the raw Firebase
  // user). Also triggers flush() on every change: this is what makes a
  // queued entry blocked pending "the original creator signs back in"
  // actually resolve promptly, rather than waiting on the next unrelated
  // flush trigger (a reconnect event, or another enqueue()).
  useEffect(() => {
    const userId = state.profile?.id ?? null;
    setCurrentUserProvider(() => Promise.resolve(userId));
    if (userId) {
      flush().catch(() => {});
    }
  }, [state.profile]);

  useEffect(() => {
    if (!isFirebaseConfigured) {
      setState({ status: "unconfigured", profile: null, error: null });
      return undefined;
    }

    // Kicked off unconditionally, at mount — see the bundle-size/offline
    // note above for why deferring the SDK to here (rather than a static
    // top-level import) doesn't delay this any further than before.
    let unsubscribe;
    let cancelled = false;

    loadFirebaseAuth().then((resolved) => {
      if (cancelled || !resolved) return;
      const { auth, authSdk } = resolved;

      unsubscribe = authSdk.onAuthStateChanged(auth, (user) => {
        setFirebaseUser(user ?? null);

        if (!user) {
          setState({ status: "signed_out", profile: null, error: null });
          return;
        }

        setState({ status: "loading", profile: null, error: null });

        getMe()
          .then((profile) => {
            // Persist on every success — this is what makes the degraded
            // path above possible on a LATER offline relaunch. Never
            // persisted: any token/credential (see profileCache.js).
            cacheProfile(user.uid, profile);
            return deriveAuthState({ ok: true, profile });
          })
          .catch((err) =>
            deriveAuthState(meResultFromError(err), readCachedProfile(user.uid)?.profile ?? null)
          )
          .then(setState);
      });
    });

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email, password) => {
    if (!isFirebaseConfigured) {
      throw new Error("Auth is not configured for this environment.");
    }
    const { auth, authSdk } = await loadFirebaseAuth();
    await authSdk.signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged above picks up the resulting user and drives /me.
  }, []);

  const signOut = useCallback(async () => {
    if (!isFirebaseConfigured) return;
    const { auth, authSdk } = await loadFirebaseAuth();
    // Explicit sign-out is a deliberate "I'm done on this device" signal —
    // clear the cached profile so a different cashier signing in next on
    // this shared device never sees a stale fallback for someone else's
    // account (the degraded path above only ever consults the cache for the
    // uid Firebase itself currently reports as signed in, but there's no
    // reason to keep it around past an explicit sign-out either).
    if (firebaseUser) {
      clearCachedProfile(firebaseUser.uid);
    }
    await authSdk.signOut(auth);
  }, [firebaseUser]);

  const value = useMemo(
    () => ({
      user: firebaseUser ?? null,
      profile: state.profile,
      status: state.status,
      error: state.error,
      signIn,
      signOut,
    }),
    [firebaseUser, state, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * useAuth — the only way feature code should read auth/profile state.
 * Throws if used outside AuthProvider so misuse fails loudly in
 * development rather than silently rendering with undefined values.
 */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error("useAuth() must be used within an <AuthProvider>.");
  }
  return ctx;
}
