/**
 * AuthProvider — the token provider must be registered before the first
 * request goes out.
 *
 * Regression cover for a bug that reached production. `onAuthStateChanged`
 * called `setFirebaseUser(user)` and then `getMe()` synchronously, while
 * `setTokenProvider` was registered from a `useEffect` keyed on
 * `[firebaseUser]`. Effects run after React re-renders, which is after the
 * callback returns — so the very first `/me` after sign-in was issued with
 * the PREVIOUS provider (`() => null`) and the API answered 401
 * UNAUTHENTICATED / "Missing or malformed Authorization header".
 *
 * It lost that race every time, not intermittently. It survived to
 * production because every other call — products, stock levels, sales —
 * happens later, once the effect has run, so the app looked healthy while
 * `/me` alone failed, and `/me`'s failure path degrades quietly to the
 * cached profile rather than surfacing anything.
 *
 * The assertion below is deliberately about the OBSERVABLE property rather
 * than call ordering: at the moment `getMe()` runs, asking the registered
 * provider for a token must actually produce one. A test that only checked
 * "setTokenProvider was called before getMe" would still pass if the
 * provider registered were the null one.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

const ID_TOKEN = "fake-id-token-abc123";

// The provider currently registered with @ub/api-client, and what a request
// issued at getMe() time would have carried.
let registeredProvider = async () => null;
let tokenSeenByGetMe = "__never_called__";
let authStateCallback = null;

vi.mock("@ub/api-client", () => ({
  setTokenProvider: (fn) => {
    registeredProvider = fn;
  },
  getMe: vi.fn(async () => {
    // Stands in for apiFetch, which calls the registered provider on every
    // request (see packages/api-client/_base.js).
    tokenSeenByGetMe = await registeredProvider();
    return { id: "u1", role: "outlet_manager", outlet_id: "outlet-1", display_name: "Kojo" };
  }),
  ApiClientError: class ApiClientError extends Error {},
}));

vi.mock("@ub/offline-queue", () => ({
  setCurrentUserProvider: vi.fn(),
  flush: vi.fn(async () => {}),
}));

vi.mock("./profileCache.js", () => ({
  cacheProfile: vi.fn(),
  readCachedProfile: vi.fn(() => null),
  clearCachedProfile: vi.fn(),
}));

vi.mock("./firebase.js", () => ({
  isFirebaseConfigured: true,
  loadFirebaseAuth: async () => ({
    auth: {},
    authSdk: {
      onAuthStateChanged: (_auth, cb) => {
        authStateCallback = cb;
        return () => {};
      },
      signInWithEmailAndPassword: vi.fn(),
      signOut: vi.fn(),
    },
  }),
}));

const { AuthProvider } = await import("./AuthContext.jsx");

beforeEach(() => {
  registeredProvider = async () => null;
  tokenSeenByGetMe = "__never_called__";
  authStateCallback = null;
});

describe("AuthProvider token provider registration", () => {
  it("has a working token provider registered by the time the first /me is issued", async () => {
    render(
      <AuthProvider>
        <div />
      </AuthProvider>
    );

    await waitFor(() => expect(authStateCallback).toBeTypeOf("function"));

    // Firebase reports a signed-in user. This is the moment the bug occurred:
    // getMe() is called synchronously from inside this callback.
    authStateCallback({ uid: "u1", getIdToken: async () => ID_TOKEN });

    await waitFor(() => expect(tokenSeenByGetMe).not.toBe("__never_called__"));

    expect(tokenSeenByGetMe).toBe(ID_TOKEN);
  });

  it("clears the token provider when the user signs out", async () => {
    render(
      <AuthProvider>
        <div />
      </AuthProvider>
    );
    await waitFor(() => expect(authStateCallback).toBeTypeOf("function"));

    authStateCallback({ uid: "u1", getIdToken: async () => ID_TOKEN });
    await waitFor(() => expect(tokenSeenByGetMe).toBe(ID_TOKEN));

    authStateCallback(null);
    await waitFor(async () => expect(await registeredProvider()).toBeNull());
  });
});
