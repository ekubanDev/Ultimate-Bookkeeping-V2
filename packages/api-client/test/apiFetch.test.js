import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getMe, setTokenProvider, ApiClientError } from "../index.js";

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

/**
 * A non-2xx response with NO parseable `{ error: {...} }` envelope — exactly
 * what a bare 500 looks like (apps/api/app/main.py has no catch-all
 * exception handler), and what other infra failures (proxy timeout, LB
 * health-check body) tend to look like too. `.json()` rejects, matching a
 * real `fetch` Response whose body isn't valid JSON at all (e.g. an HTML
 * error page from a proxy).
 */
function mockFetchFailingWithNoEnvelope(status) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.reject(new Error("Unexpected token < in JSON")),
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

/**
 * Bare non-2xx responses with no parseable error envelope (Adjoa QA
 * finding, folded in alongside bug #2): a 5xx with no envelope must be
 * retryable, and a 4xx with no envelope must not be — getting this backwards
 * for the 5xx case combines with bug #2 (no resolve UI) to permanently
 * strand a perfectly valid, unrelated sale as unretryable the moment the
 * backend throws an unhandled 500. This branch previously had no coverage
 * at all.
 */
describe("apiFetch — non-2xx response with no parseable error envelope", () => {
  it("treats a bare 5xx (e.g. an unhandled 500) as retryable", async () => {
    setTokenProvider(() => null);
    mockFetchFailingWithNoEnvelope(500);

    await expect(getMe()).rejects.toMatchObject({
      code: "UNKNOWN_ERROR",
      retryable: true,
      status: 500,
    });
  });

  it("treats every 5xx status, not just 500, as retryable", async () => {
    setTokenProvider(() => null);
    for (const status of [502, 503, 599]) {
      mockFetchFailingWithNoEnvelope(status);
      await expect(getMe()).rejects.toMatchObject({ retryable: true, status });
    }
  });

  it("treats a bare 4xx (e.g. a malformed request rejected before it could be JSON-encoded) as NOT retryable", async () => {
    setTokenProvider(() => null);
    mockFetchFailingWithNoEnvelope(400);

    await expect(getMe()).rejects.toMatchObject({
      code: "UNKNOWN_ERROR",
      retryable: false,
      status: 400,
    });
  });

  it("still throws an ApiClientError instance in both cases, not a plain object", async () => {
    setTokenProvider(() => null);
    mockFetchFailingWithNoEnvelope(500);
    await expect(getMe()).rejects.toBeInstanceOf(ApiClientError);
  });

  it("a well-formed envelope on a 5xx still wins over the status-based fallback (existing behavior, unchanged)", async () => {
    setTokenProvider(() => null);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () =>
        Promise.resolve({
          error: { code: "SERVICE_UNAVAILABLE", message: "try later", retryable: false },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getMe()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      retryable: false,
    });
  });
});
