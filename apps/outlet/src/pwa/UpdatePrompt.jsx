import { useReducer } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { INITIAL_STATE, reduceUpdatePrompt } from "./updatePromptMachine.js";

/**
 * UpdatePrompt — registers the service worker and owns the
 * offline-ready / update-available UI. Mounted once, at the top of
 * App.jsx, outside the auth gate (see App.jsx) — a cashier on the login
 * screen benefits from a fresh build just as much as one mid-shift.
 *
 * UPDATE LIFECYCLE (Kojo, 2026-09): vite.config.js sets `registerType:
 * 'prompt'`, so a newly-fetched service worker sits in the browser's
 * "waiting" state until something explicitly tells it to activate — it
 * does NOT auto-swap the running app out from under an open cart. That
 * activation trigger is `updateServiceWorker()` below, called only when
 * the cashier taps "Reload to update" in the banner this component
 * renders.
 *
 * Two lifecycle options were on the table:
 *   1. This one — an explicit "new version available, reload" affordance.
 *   2. "Update on next cold start" — never prompt; just let the waiting SW
 *      activate naturally once every tab/instance of the old version is
 *      closed (the standard browser SW lifecycle when nothing calls
 *      skipWaiting()).
 * Chosen: (1), but note it doesn't actually give up (2) — it *adds* to it.
 * If a cashier dismisses the banner (or never sees it — app closed instead
 * of reloaded), nothing forces the issue: the waiting SW simply activates
 * on its own the next time every tab of this app is fully closed and
 * reopened (e.g. next shift's cold start on the till), which is option 2's
 * behaviour for free. So the effective policy is "prompt now, cold-start
 * fallback if ignored" — never a silent mid-shift swap, never a build that
 * lingers forever unapplied either.
 *
 * Registration itself (`useRegisterSW`) is guarded by
 * `'serviceWorker' in navigator` inside vite-plugin-pwa's generated
 * register function, so this is a safe no-op in environments without SW
 * support (and, not incidentally, that's also why this component doesn't
 * need special-casing for jsdom/vitest beyond the module-level mock used
 * in App.test.jsx — see that file).
 *
 * Does NOT own: precaching/runtime-caching rules (vite.config.js), the
 * decision of *what* counts as a cacheable read (src/pwa/apiCacheRoutes.js).
 * Does NOT own: retry/replay of any queued write — offline-queue's
 * client_id contract is untouched by any of this.
 */
export default function UpdatePrompt() {
  const [state, dispatch] = useReducer(reduceUpdatePrompt, INITIAL_STATE);

  const { updateServiceWorker } = useRegisterSW({
    onOfflineReady() {
      dispatch({ type: "OFFLINE_READY" });
    },
    onNeedRefresh() {
      dispatch({ type: "NEED_REFRESH" });
    },
  });

  if (state === "idle" || state === "reloading") {
    // 'reloading': the page navigates away as soon as the new SW takes
    // control (see registerSW's 'controlling' listener, vite-plugin-pwa's
    // generated client code) — nothing left to render.
    return null;
  }

  if (state === "offline-ready") {
    return (
      <div className="ub-update-prompt ub-update-prompt--offline-ready" role="status">
        <span>Ready to work offline.</span>
        <button type="button" onClick={() => dispatch({ type: "DISMISS" })}>
          Dismiss
        </button>
      </div>
    );
  }

  // state === "update-available"
  return (
    <div className="ub-update-prompt ub-update-prompt--update-available" role="status">
      <span>New version available.</span>
      <button
        type="button"
        onClick={() => {
          dispatch({ type: "CONFIRM_RELOAD" });
          updateServiceWorker();
        }}
      >
        Reload to update
      </button>
      <button type="button" onClick={() => dispatch({ type: "DISMISS" })}>
        Later
      </button>
    </div>
  );
}
