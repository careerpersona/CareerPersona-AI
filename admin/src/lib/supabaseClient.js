import { createClient } from "@supabase/supabase-js";

// Same Supabase project as the customer app (src/lib/supabaseClient.js) --
// the Back Office reuses the existing Auth user pool, never a second
// authentication system. A staff member signs in here with the exact same
// email/password (or however they authenticate on the customer site); what
// differs is the follow-up check against the Worker's /api/admin/session
// (see lib/adminApi.js), not the identity provider itself.
//
// This is the anon/publishable key -- safe to expose client-side. It grants
// no access to `staff` or `admin_audit_log` (Work Order 1: both tables have
// RLS enabled with zero policies, so even an authenticated staff session
// cannot read them directly through this client). All Back Office data
// access goes through the Worker's service_role connection instead.
const SUPABASE_URL = "https://cbzebqxbohgkgcqfgmdm.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNiemVicXhib2hna2djcWZnbWRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNzI4ODMsImV4cCI6MjA5NzY0ODg4M30._W9GabazL0_RG-N3wq6raRtRwM83VqqRJQqi6Vq0kmk";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
