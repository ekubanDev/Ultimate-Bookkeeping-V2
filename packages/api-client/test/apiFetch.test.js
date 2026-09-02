import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getMe, setTokenProvider } from "../index.js";

/**
 * Exercises apiFetch's Authorization-header wiring (task: "add
 * setTokenProvider(fn) hook... apiFetch calls it and sets the Authorization
 * header when a token exists") through the public @ub/api-client surface —
 * getMe() is a thin pass-through to apiFetch, so asserting on the fetch call
 * it produces is equivalent to testing apiFetch directly without reaching
 * into the package's internal _base.js export.
 */

function mockFetchResolving(body = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch Authorization header wiring", () => {
  it("omits the Authorization header when the token provider resolves to no token", async () => {
    setTokenProvider(() => null);
    const fetchMock = mockFetchResolving();

    await getMe();

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("omits the Authorization header when the token provider resolves to an async null", async () => {
    setTokenProvider(async () => null);
    const fetchMock = mockFetchResolving();

    await getMe();

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("attaches 'Authorization: Bearer <token>' when the token provider resolves to a token", async () => {
    setTokenProvider(async () => "test-id-token");
    const fetchMock = mockFetchResolving();

    await getMe();

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer test-id-token");
  });

  it("reflects a freshly-registered token provider on the very next call (e.g. token refresh)", async () => {
    setTokenProvider(async () => "stale-token");
    let fetchMock = mockFetchResolving();
    await getMe();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer stale-token");

    setTokenProvider(async () => "fresh-token");
    fetchMock = mockFetchResolving();
    await getMe();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer fresh-token");
  });

  it("hits GET /api/v1/me", async () => {
    setTokenProvider(() => null);
    const fetchMock = mockFetchResolving({ id: "u1" });

    await getMe();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/me");
    expect(init.method).toBe("GET");
  });
});
