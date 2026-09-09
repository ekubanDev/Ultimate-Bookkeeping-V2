/**
 * updatePromptMachine.js — pure state machine behind UpdatePrompt.jsx.
 *
 * Deliberately separated from UpdatePrompt.jsx so the update-lifecycle
 * *decisions* (what should happen when the SW reports it's ready to work
 * offline, vs. reports a new version is waiting, vs. the cashier dismisses
 * or confirms) are testable in plain vitest, with zero dependency on
 * `virtual:pwa-register/react` or the actual Workbox runtime — matching
 * how firebase.js separates `resolveFirebaseConfig` (pure, tested) from
 * `loadFirebaseAuth` (SDK-touching, not unit-tested).
 *
 * States:
 *   - 'idle'              — nothing to show.
 *   - 'offline-ready'      — first install finished precaching; informational,
 *                            calm, dismissible. (Mirrors vite-plugin-pwa's
 *                            recommended onOfflineReady signal.)
 *   - 'update-available'   — a new build is precached and waiting; the
 *                            cashier must confirm before it activates (see
 *                            registerType: 'prompt' in vite.config.js — this
 *                            state is exactly why that mode was chosen over
 *                            'autoUpdate').
 *   - 'reloading'          — the cashier confirmed; updateServiceWorker()
 *                            has been told to activate the new SW, which
 *                            reloads the page once it takes control. Nothing
 *                            left for this state machine to do.
 */

export const INITIAL_STATE = "idle";

/**
 * reduceUpdatePrompt — (state, event) -> next state.
 *
 * Event-ordering guarantees this encodes:
 *   - NEED_REFRESH always wins: an update becoming available is more
 *     important than a stale "ready to work offline" notice, so it
 *     overrides 'offline-ready' (and is a no-op-safe overwrite of 'idle').
 *   - OFFLINE_READY never interrupts an update prompt already showing —
 *     if NEED_REFRESH already fired, staying on 'update-available' is
 *     correct; there's nothing for the offline-ready notice to add.
 *   - DISMISS only clears the two informational/actionable states; it's a
 *     no-op from 'idle' or 'reloading' (nothing to dismiss, and a reload
 *     already in flight shouldn't be interruptible by a stray dismiss).
 *   - CONFIRM_RELOAD only fires from 'update-available' — confirming from
 *     any other state would mean calling updateServiceWorker() with no
 *     update actually waiting, which UpdatePrompt.jsx's rendering already
 *     makes unreachable (no button exists in other states), but the
 *     reducer enforces it too rather than trusting the caller.
 *
 * @param {'idle'|'offline-ready'|'update-available'|'reloading'} state
 * @param {{ type: 'OFFLINE_READY' | 'NEED_REFRESH' | 'DISMISS' | 'CONFIRM_RELOAD' }} event
 * @returns {'idle'|'offline-ready'|'update-available'|'reloading'}
 */
export function reduceUpdatePrompt(state, event) {
  switch (event.type) {
    case "OFFLINE_READY":
      return state === "idle" ? "offline-ready" : state;

    case "NEED_REFRESH":
      return "update-available";

    case "DISMISS":
      return state === "offline-ready" || state === "update-available" ? "idle" : state;

    case "CONFIRM_RELOAD":
      return state === "update-available" ? "reloading" : state;

    default:
      return state;
  }
}
