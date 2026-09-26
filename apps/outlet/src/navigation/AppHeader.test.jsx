/**
 * AppHeader — the app's only sign-out, and the guard in front of it.
 *
 * Before this existed, AuthContext exposed signOut and nothing called it, so
 * the identity-mismatch recovery the runbook documents ("have that person
 * sign in on this device") could not be performed at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import AppHeader from "./AppHeader.jsx";

const signOutMock = vi.fn();
let mockProfile = {
  id: "user-1",
  role: "outlet_manager",
  outlet_id: "outlet-1",
  display_name: "Ama Mensah",
};

vi.mock("../auth/AuthContext.jsx", () => ({
  useAuth: () => ({ profile: mockProfile, signOut: signOutMock }),
}));

let mockSync = {
  queuedCount: 0,
  hasFailures: false,
  failedEntries: [],
};

vi.mock("../features/sync-status/useSyncStatus.js", () => ({
  useSyncStatus: () => mockSync,
}));

beforeEach(() => {
  signOutMock.mockReset();
  signOutMock.mockResolvedValue(undefined);
  mockProfile = {
    id: "user-1",
    role: "outlet_manager",
    outlet_id: "outlet-1",
    display_name: "Ama Mensah",
  };
  mockSync = { queuedCount: 0, hasFailures: false, failedEntries: [] };
});

describe("AppHeader", () => {
  it("shows who is signed in, so 'recorded by another user' is actionable", () => {
    render(<AppHeader />);
    expect(screen.getByText("Ama Mensah")).toBeTruthy();
  });

  it("signs out immediately when nothing is queued", () => {
    render(<AppHeader />);

    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("does NOT sign out on the first click when work is unsynced", () => {
    mockSync = { queuedCount: 3, hasFailures: false, failedEntries: [] };
    render(<AppHeader />);

    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    // The load-bearing assertion: the queue's author must not be swapped out
    // from under three unsent sales by a single stray tap.
    expect(signOutMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("explains that the items are kept, not lost, and who can send them", () => {
    mockSync = { queuedCount: 3, hasFailures: false, failedEntries: [] };
    render(<AppHeader />);

    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toMatch(/3 item\(s\) have not reached the server/);
    expect(dialog.textContent).toMatch(/are not lost/);
    expect(dialog.textContent).toMatch(/Ama Mensah/);
  });

  it("counts failed entries as unsynced too, not just queued ones", () => {
    mockSync = {
      queuedCount: 1,
      hasFailures: true,
      failedEntries: [{ client_id: "a" }, { client_id: "b" }],
    };
    render(<AppHeader />);

    expect(screen.getByText("3 not yet synced")).toBeTruthy();
  });

  it("goes through once confirmed", () => {
    mockSync = { queuedCount: 2, hasFailures: false, failedEntries: [] };
    render(<AppHeader />);

    fireEvent.click(screen.getByRole("button", { name: /^sign out/i }));
    fireEvent.click(screen.getByRole("button", { name: /sign out anyway/i }));

    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it("stays signed in when the confirmation is declined", () => {
    mockSync = { queuedCount: 2, hasFailures: false, failedEntries: [] };
    render(<AppHeader />);

    fireEvent.click(screen.getByRole("button", { name: /^sign out/i }));
    fireEvent.click(screen.getByRole("button", { name: /stay signed in/i }));

    expect(signOutMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows no pending badge when the queue is empty", () => {
    render(<AppHeader />);
    expect(screen.queryByText(/not yet synced/)).toBeNull();
  });

  it("renders nothing without a profile, rather than an empty bar", () => {
    mockProfile = null;
    const { container } = render(<AppHeader />);
    expect(container.firstChild).toBeNull();
  });
});
