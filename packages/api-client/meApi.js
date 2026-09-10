/**
 * Thin wrapper over GET /api/v1/me — the source of truth for the signed-in
 * user's role and outlet_id (backend ignores any client-supplied outlet_id
 * for outlet managers; the client always sends what /me said). Called by
 * apps/outlet/src/auth/AuthContext.jsx right after Firebase sign-in.
 */
import { apiFetch } from "./_base.js";

/**
 * GET /api/v1/me
 * @returns {Promise<{ id: string, role: 'admin'|'outlet_manager', outlet_id: string|null, display_name: string }>}
 */
export function getMe() {
  return apiFetch("/me", { method: "GET" });
}
