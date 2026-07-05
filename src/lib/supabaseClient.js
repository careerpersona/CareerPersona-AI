import { createClient } from "@supabase/supabase-js";

// Anon/publishable key — safe to expose client-side. Every table is protected by
// row-level security scoped to auth.uid(), so this key alone grants no data access.
const SUPABASE_URL = "https://cbzebqxbohgkgcqfgmdm.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNiemVicXhib2hna2djcWZnbWRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNzI4ODMsImV4cCI6MjA5NzY0ODg4M30._W9GabazL0_RG-N3wq6raRtRwM83VqqRJQqi6Vq0kmk";

// Capture the URL hash AND search params synchronously before createClient()
// processes and removes them. Used by useAuth to:
//  • seed recoveryMode on the very first render (type=recovery in hash)
//  • detect auth callback URLs so a loading screen is shown while the PKCE code
//    or implicit token is being exchanged (prevents the login-page flash)
export const initialLocationHash =
  typeof window !== "undefined" ? window.location.hash : "";
export const initialLocationSearch =
  typeof window !== "undefined" ? window.location.search : "";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
