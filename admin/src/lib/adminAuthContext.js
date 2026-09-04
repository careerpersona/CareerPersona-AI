import { createContext } from "react";

// Split into its own file (no JSX/components here) so AdminAuthProvider.jsx
// and useAdminAuth.js can each export only what React Fast Refresh expects
// them to: a component, and a hook/helpers, respectively.
export const AdminAuthContext = createContext(null);
