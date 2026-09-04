import { useContext } from "react";
import { AdminAuthContext } from "./lib/adminAuthContext.js";

export function useAdminAuth() {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) throw new Error("useAdminAuth must be used within AdminAuthProvider");
  return ctx;
}

// Role-aware foundation for future gated features -- no route or component
// uses this yet (Work Order 2 builds no admin business functionality), but
// the shape exists so a future feature can gate on it without inventing its
// own convention. superadmin implicitly satisfies any role requirement.
export function hasRole(role, allowed) {
  if (!role) return false;
  if (role === "superadmin") return true;
  return allowed.includes(role);
}

export const ROLE_LABELS = {
  support: "Support",
  billing_ops: "Billing Ops",
  superadmin: "Superadmin",
};
