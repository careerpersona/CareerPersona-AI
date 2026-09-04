import { AdminAuthProvider } from "./AdminAuthProvider.jsx";
import { useAdminAuth } from "./useAdminAuth.js";
import LoginPage from "./LoginPage.jsx";
import AccessDeniedPage from "./AccessDeniedPage.jsx";
import AdminShell from "./AdminShell.jsx";
import StatusScreen from "./StatusScreen.jsx";
import AcceptInvitePage from "./AcceptInvitePage.jsx";

// Staff Invitation & Onboarding: detected before AdminAuthProvider mounts at
// all -- an invitee has no session and no staff row yet, so the normal
// auth-check gate below has nothing useful to do for them. Uses the hash
// (not query params) to match this app's own #route convention
// (AdminShell's parseHash), e.g. #accept-invite?token=<hashedToken>.
function parseAcceptInviteHash() {
  const h = window.location.hash.replace(/^#\/?/, "");
  if (!h.startsWith("accept-invite")) return null;
  const queryPart = h.split("?")[1] || "";
  return new URLSearchParams(queryPart).get("token");
}

function Gate() {
  const { status, retry } = useAdminAuth();

  if (status === "loading" || status === "checking_admin") {
    return <StatusScreen message="Checking your Back Office access…" />;
  }
  if (status === "signed_out") return <LoginPage />;
  if (status === "unauthorized") return <AccessDeniedPage />;
  if (status === "error") {
    return <StatusScreen message="Couldn't verify Back Office access. Check your connection and try again." retry={retry} />;
  }
  return <AdminShell />; // status === "authorized"
}

export default function App() {
  const acceptInviteToken = parseAcceptInviteHash();
  if (acceptInviteToken !== null) return <AcceptInvitePage tokenHash={acceptInviteToken} />;

  return (
    <AdminAuthProvider>
      <Gate />
    </AdminAuthProvider>
  );
}
