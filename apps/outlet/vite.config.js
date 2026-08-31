import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite config for the Outlet app.
 *
 * Build tool decision: Vite, chosen provisionally by Kojo per
 * ultimate-bookkeeping-v2-outlet-ui-plan.md §6 open item ("Confirm build
 * tool (Vite vs. CRA/craco carryover)"). Reversible — flagged in the
 * scaffold report, not yet signed off by Kwame.
 *
 * Kept deliberately small: this app targets cheap Android devices on bad
 * connections, so bundle size matters more than build-tool flexibility.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
