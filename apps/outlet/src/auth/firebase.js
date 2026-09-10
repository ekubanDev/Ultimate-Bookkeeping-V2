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
 * AUTH EMULATOR (Kojo, 2026-09): when `VITE_FIREBASE_AUTH_EMULATOR_HOST` is
 * set (see .env.example), this calls `connectAuthEmulator` immediately
 * after `getAuth()`, before any sign-in call can reach the network — the
 * SDK requires that ordering (connecting the emulator after any request has
 * gone out is a no-op at best, an assertion failure at worst; see
 * `@firebase/auth`'s `_canInitEmulator` guard). This lets a developer run
 * fully local (Firebase's `firebase emulators:start`, matched on the
 * backend by Efua's `FIREBASE_AUTH_EMULATOR_HOST`) with no real GCP
 * project — see the .env.example comments for the exact combination of
 * vars each mode needs.
 *
 * Deliberately gated on nothing but that one env var being present/absent
 * — no separate "dev mode" flag — so:
 *   - It can never activate in a production build unless someone
 *     explicitly ships `VITE_FIREBASE_AUTH_EMULATOR_HOST` in that build's
 *     env, which is not something any of this repo's build/deploy config
 *     does (see apps/outlet/README.md).
 *   - `isFirebaseConfigured` (above) is UNCHANGED by emulator mode: the
 *     Auth SDK's own emulator flow still requires a resolvable
 *     `apiKey`/`projectId` shaped like real config (see
 *     resolveFirebaseConfig) — verified directly against
 *     `@firebase/auth`'s source rather than assumed: `authDomain` is only
 *     asserted for popup/redirect flows (`getIframeUrl`,
 *     `_getRedirectUrl`) this app never calls (it only uses
 *     `signInWithEmailAndPassword`/`onAuthStateChanged`/`signOut` — see
 *     the authSdk surface below), but `apiKey` is threaded into every
 *     Identity Toolkit REST call the SDK makes, emulator or not. The
 *     values can all be harmless dummies in emulator mode (the emulator
 *     doesn't validate them against a real Google Cloud project — see
 *     .env.example) — but they still have to be *present*, so
 *     `isFirebaseConfigured` staying a plain "are all three set" check is
 *     still the right test in both modes, not something emulator mode
 *     needs to special-case.
 *
 * @returns {Promise<{ auth: import("firebase/auth").Auth, authSdk: { onAuthStateChanged: Function, signInWithEmailAndPassword: Function, signOut: Function } } | null>}
 */
export function loadFirebaseAuth() {
  if (!isFirebaseConfigured) {
    return Promise.resolve(null);
  }
  if (!firebaseAuthPromise) {
    firebaseAuthPromise = Promise.all([import("firebase/app"), import("firebase/auth")]).then(
      ([
        { initializeApp },
        { getAuth, connectAuthEmulator, onAuthStateChanged, signInWithEmailAndPassword, signOut },
      ]) => {
        const auth = getAuth(initializeApp(config));

        // See the AUTH EMULATOR doc comment above for why this is gated on
        // this one env var alone, and why it's safe to do unconditionally
        // (no real project ever has this var set).
        const emulatorHost = import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_HOST;
        if (emulatorHost) {
          // connectAuthEmulator wants a full URL (it asserts a
          // /^https?:\/\// prefix); the env var itself deliberately stays
          // in the same bare "host:port" shape as the backend's
          // `FIREBASE_AUTH_EMULATOR_HOST` (the Firebase Admin SDK's own
          // convention — see apps/api's matching support) so a developer
          // sets the *same* value on both sides instead of a
          // frontend-specific URL-shaped variant of it.
          connectAuthEmulator(auth, `http://${emulatorHost}`);
        }

        return { auth, authSdk: { onAuthStateChanged, signInWithEmailAndPassword, signOut } };
      }
    );
  }
  return firebaseAuthPromise;
}
