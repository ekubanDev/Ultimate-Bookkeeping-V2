/**
 * OutletNav's docstring claims it "owns the visual active tab state", but
 * nothing verified that and the className is a plain string. These tests pin
 * down what React Router actually does, because the stylesheet depends on it:
 * app.css styles the active tab via `.active` and `[aria-current="page"]`,
 * and if the router stopped emitting either, the nav would silently lose its
 * only "where am I" cue with every test still green.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import OutletNav from "./OutletNav.jsx";

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <OutletNav />
    </MemoryRouter>
  );
}

describe("OutletNav", () => {
  it("renders all four destinations", () => {
    renderAt("/pos");
    for (const label of ["POS", "Stock", "Expenses", "Sync"]) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }
  });

  it("marks the current tab with aria-current, which the stylesheet targets", () => {
    renderAt("/stock");

    expect(
      screen.getByRole("link", { name: "Stock" }).getAttribute("aria-current")
    ).toBe("page");
    expect(
      screen.getByRole("link", { name: "POS" }).getAttribute("aria-current")
    ).toBeNull();
  });

  it("also carries the `active` class the stylesheet targets", () => {
    renderAt("/expenses");
    expect(
      screen.getByRole("link", { name: "Expenses" }).classList.contains("active")
    ).toBe(true);
    expect(
      screen.getByRole("link", { name: "Sync" }).classList.contains("active")
    ).toBe(false);
  });

  it("keeps the base class so the tab is styled whether active or not", () => {
    renderAt("/pos");
    for (const label of ["POS", "Stock"]) {
      expect(
        screen
          .getByRole("link", { name: label })
          .classList.contains("ub-outlet-nav__item")
      ).toBe(true);
    }
  });

  it("moves the active marker when the route changes", () => {
    const { unmount } = renderAt("/sync");
    expect(
      screen.getByRole("link", { name: "Sync" }).getAttribute("aria-current")
    ).toBe("page");
    unmount();

    renderAt("/pos");
    expect(
      screen.getByRole("link", { name: "POS" }).getAttribute("aria-current")
    ).toBe("page");
    expect(
      screen.getByRole("link", { name: "Sync" }).getAttribute("aria-current")
    ).toBeNull();
  });
});
