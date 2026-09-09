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
 *
 * BUNDLE-SIZE NOTE (Kojo, 2026-09): `firebase/app` + `firebase/auth` are
 * ~150KB minified (~34% of the whole outlet bundle, measured with
 * source-map-explorer — see bundle report) — the single largest dependency
 * in this app by a wide margin. They're loaded via dynamic import() below
 * instead of a static top-level import, so Vite puts them in their own
 * chunk instead of baking them into the bundle every screen needs just to
 * boot. `isFirebaseConfigured` deliberately stays a synchronous, SDK-free
 * check (see resolveFirebaseConfig below) so App.jsx can still show the
 * 'unconfigured' message instantly, with zero network activity, exactly as
 * before. See loadFirebaseAuth()'s doc comment and AuthContext.jsx for why
 * deferring the SDK this way doesn't trade away offline safety or delay
 * perceived first paint.
 */

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

/**
 * True when VITE_FIREBASE_* env vars are all present — see .env.example.
 * Computed with zero Firebase SDK involvement (just reads plain strings via
 * resolveFirebaseConfig), so this is available instantly, before the SDK
 * chunk has even started downloading.
 */
export const isFirebaseConfigured = config !== null;

let firebaseAuthPromise = null;

/**
 * loadFirebaseAuth — dynamically imports `firebase/app` + `firebase/auth`,
 * initializes the app once, and resolves to `{ auth, authSdk }`, where
 * `authSdk` exposes only the three `firebase/auth` functions this app
 * actually calls (`onAuthStateChanged`, `signInWithEmailAndPassword`,
 * `signOut`) and `auth` is the initialized Auth instance to pass to them.
 * (Named-destructuring the SDK's exports here instead of returning its
 * whole namespace was tried specifically to see if it improved
 * tree-shaking of the resulting chunk — measured, it made no difference;
 * see the bundle report. Kept anyway since it documents the real surface
 * area used.)
 *
 * Memoized: the SDK is fetched and initialized at most once per page load,
 * no matter how many times this is called — AuthProvider calls it once at
 * mount to start listening for auth-state changes, and signIn()/signOut()
 * call it again later but reuse the same resolved promise/instance.
 *
 * Resolves to `null` immediately, with no network activity at all, when
 * Firebase isn't configured — callers must still check
 * `isFirebaseConfigured` first (same contract as before this was made
 * lazy) rather than relying on this resolving to null.
 *
 * Offline-safety: this must be called unconditionally, as early as
 * possible (AuthProvider's mount effect, not gated behind any user
 * action), so the fetch happens at the same moment the SDK previously
 * would have been forced to load as part of the monolithic bundle — i.e.
 * this doesn't create a *new* window where the app works online, goes
 * offline, and only then discovers it needs to fetch something it never
 * fetched before. See AuthContext.jsx's top-of-file note for the full
 * reasoning, and the bundle report for why this is NOT extended to
 * React.lazy-splitting the Stock/Expenses screens, and for the measured
 * total-bytes tradeoff of this split (smaller critical-path chunk, but
 * more total bytes once the deferred chunk loads — this is a real
 * tradeoff, not a pure win; see the report).
 *
 * @returns {Promise<{ auth: import("firebase/auth").Auth, authSdk: { onAuthStateChanged: Function, signInWithEmailAndPassword: Function, signOut: Function } } | null>}
 */
export function loadFirebaseAuth() {
  if (!isFirebaseConfigured) {
    return Promise.resolve(null);
  }
  if (!firebaseAuthPromise) {
    firebaseAuthPromise = Promise.all([import("firebase/app"), import("firebase/auth")]).then(
      ([{ initializeApp }, { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut }]) => {
        const auth = getAuth(initializeApp(config));
        return { auth, authSdk: { onAuthStateChanged, signInWithEmailAndPassword, signOut } };
      }
    );
  }
  return firebaseAuthPromise;
}
