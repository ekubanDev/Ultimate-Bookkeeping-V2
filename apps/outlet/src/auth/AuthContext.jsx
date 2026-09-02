import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from "firebase/auth";
import { getMe, setTokenProvider, ApiClientError } from "@ub/api-client";
import { auth, isFirebaseConfigured } from "./firebase.js";

/**
 * AuthContext — the single source of truth for "who is signed in, and what
 * does the backend say about them" for the whole Outlet app.
 *
 * Status machine (per the task brief):
 *   'unconfigured'   — VITE_FIREBASE_* env vars absent; SDK never touched.
 *   'loading'        — Firebase's onAuthStateChanged hasn't fired yet, or a
 *                       Firebase user exists and /me is in flight.
 *   'signed_out'      — no Firebase user.
 *   'signed_in'       — Firebase user + /me both resolved successfully.
 *   'unprovisioned'   — Firebase user exists, but /me returned
 *                       USER_NOT_PROVISIONED (403) — the account has no
 *                       corresponding `users` row yet.
 *
 * Owns: the onAuthStateChanged effect, calling /me, registering the
 * api-client token provider. Derivation of "given a firebase user + a /me
 * result (or error), what's the resulting status/profile" is pulled out
 * into pure, exported functions below per tesseract-fp-guide.md §4 — this
 * component's job is wiring effects to state, not deciding what the state
 * means.
 */
const AuthContext = createContext(null);

/**
 * deriveAuthState — pure. Given the outcome of fetching /me for a signed-in
 * Firebase user, decides the resulting {status, profile, error}. Kept
 * separate from the async /me call itself so it's unit-testable with plain
 * objects, no mocking required.
 *
 * @param {{ ok: true, profile: object } | { ok: false, code?: string, message?: string }} meResult
 * @returns {{ status: 'signed_in'|'unprovisioned', profile: object|null, error: string|null }}
 */
export function deriveAuthState(meResult) {
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

  useEffect(() => {
    if (!isFirebaseConfigured) {
      setState({ status: "unconfigured", profile: null, error: null });
      return undefined;
    }

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user ?? null);

      if (!user) {
        setState({ status: "signed_out", profile: null, error: null });
        return;
      }

      setState({ status: "loading", profile: null, error: null });

      getMe()
        .then((profile) => deriveAuthState({ ok: true, profile }))
        .catch((err) => deriveAuthState(meResultFromError(err)))
        .then(setState);
    });

    return unsubscribe;
  }, []);

  const signIn = useCallback(async (email, password) => {
    if (!isFirebaseConfigured) {
      throw new Error("Auth is not configured for this environment.");
    }
    await signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged above picks up the resulting user and drives /me.
  }, []);

  const signOut = useCallback(async () => {
    if (!isFirebaseConfigured) return;
    await firebaseSignOut(auth);
  }, []);

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
