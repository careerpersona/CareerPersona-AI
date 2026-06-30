// Baseline locale — every other locale falls back to this one for any
// key it doesn't yet define. Namespaces are added page-by-page as the
// app is translated; only global chrome (nav, user menu, notifications,
// language switcher) is translated so far.
export default {
  nav: {
    dashboard: "Dashboard",
    resume: "Resume",
    jobSearch: "Job Search",
    saved: "Saved",
    interview: "Interview",
    tracker: "Tracker",
    salary: "Salary",
    network: "Network",
    pricing: "Pricing",
  },
  userMenu: {
    profile: "Profile",
    settings: "Settings",
    signOut: "Sign Out",
    defaultName: "User",
  },
  notifications: {
    title: "Notifications",
    emptyTitle: "No notifications yet",
    emptyBody: "Job alerts, interview reminders, and AI insights will appear here.",
  },
  language: {
    title: "Language",
  },
};
