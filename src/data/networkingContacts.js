import { useSyncedList } from "./syncList";
import { normalizeFullName, normalizeEmail } from "../lib/contactNormalization";

const TABLE = "networking_contacts";
const LOCAL_KEY = "cp_network_contacts";

const toRow = (c, userId) => ({
  id: c.id,
  user_id: userId,
  name: normalizeFullName(c.name || ""),
  company: c.company || null,
  email: c.email ? normalizeEmail(c.email) : null,
  status: c.status || "Waiting for Reply",
  subject: c.subject || null,
  date_saved: c.dateSaved || null,
  generated_messages: {
    role: c.role || "",
    method: c.method || "email",
    originalMessage: c.originalMessage || "",
    linkedinMessage: c.linkedinMessage || "",
    linkedinNote: c.linkedinNote || "",
    lastFollowUpAt: c.lastFollowUpAt || null,
    followUpHistory: c.followUpHistory || [],
    followUpsSent: c.followUpsSent || 0,
  },
});

const fromRow = (r) => ({
  id: r.id,
  name: r.name || "",
  company: r.company || "",
  role: r.generated_messages?.role || "",
  email: r.email || "",
  method: r.generated_messages?.method || "email",
  subject: r.subject || "",
  originalMessage: r.generated_messages?.originalMessage || "",
  linkedinMessage: r.generated_messages?.linkedinMessage || "",
  linkedinNote: r.generated_messages?.linkedinNote || "",
  dateSaved: r.date_saved || "",
  status: r.status || "Waiting for Reply",
  lastFollowUpAt: r.generated_messages?.lastFollowUpAt || null,
  followUpHistory: r.generated_messages?.followUpHistory || [],
  followUpsSent: r.generated_messages?.followUpsSent || 0,
});

export function useNetworkingContacts(userId) {
  const [val, setValue, refresh] = useSyncedList(TABLE, LOCAL_KEY, userId, toRow, fromRow, "id");
  return [val, setValue, refresh];
}
