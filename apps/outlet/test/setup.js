/**
 * vitest setup for @ub/outlet — registers React Testing Library's DOM
 * cleanup after every test so component tests don't leak markup/handlers
 * across cases. Mirrors @ub/offline-queue's test/setup.js in spirit (one
 * obvious place for cross-cutting test wiring), scoped to this app's needs.
 */
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
