/**
 * firebase.js — the ONE place in this app that touches the Firebase SDK.
 * AuthContext.jsx builds on top of what this module exports; nothing else
 * should import "firebase/*" directly (keeps @ub/api-client and every other
 * feature folder free of a Firebase dependency, per the auth wiring notes
 * in AuthContext.jsx).
 *
 * Config comes from VITE_FIREBASE_* env vars (see .env.example). This repo
 * targets cheap Android devices on patchy West African mobile networks —
 * failing loudly and clearly here beats a silent crash or a UI that pretends
 * to be signed in when it isn't.
 */
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

/**
 * Pure — reads a plain object of env-var-shaped values (not `import.meta.env`
 * itself) and decides whether Firebase is configured. Kept separate from the
 * side-effecting `initializeApp`/`getAuth` calls below so it's testable
 * without mocking the SDK, per tesseract-fp-guide.md §4 ("derivation logic
 * as small exported pure functions").
 *
 * @param {{ apiKey?: string, authDomain?: string, projectId?: string }} env
 * @returns {{apiKey: string, authDomain: string, projectId: string} | null}
 *   the resolved config, or null if any required var is missing/blank.
 */
export function resolveFirebaseConfig(env) {
  const apiKey = env?.apiKey;
  const authDomain = env?.authDomain;
  const projectId = env?.projectId;

  if (!apiKey || !authDomain || !projectId) {
    return null;
  }

  return { apiKey, authDomain, projectId };
}

const config = resolveFirebaseConfig({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
});

/** True when VITE_FIREBASE_* env vars are all present — see .env.example. */
export const isFirebaseConfigured = config !== null;

/**
 * The initialized Firebase Auth instance, or null when unconfigured.
 * AuthContext.jsx must check `isFirebaseConfigured` (or that this is
 * non-null) before touching `auth` — consumers should surface an
 * "auth not configured" state rather than calling SDK methods on null.
 */
export const auth = isFirebaseConfigured ? getAuth(initializeApp(config)) : null;
