export type EmailStatus = "pending" | "approved" | "rejected";

export type BriefingEmail = {
  id: string;
  threadId: string;
  senderName: string;
  senderEmail: string;
  subject: string;
  receivedAt: string;
  urgencyScore: number;
  urgencyReason: string;
  summary: string;
  draftReply: string;
  status: EmailStatus;
};

export type CalendarEvent = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
};

export type BriefingStats = {
  priorityEmails: number;
  meetingsToday: number;
  approvedReplies: number;
};

export type Briefing = {
  id: string;
  userId: string;
  generatedAt: string;
  stats: BriefingStats;
  emails: BriefingEmail[];
  calendar: CalendarEvent[];
};

export type Preferences = {
  userId: string;
  briefingTime: string;
  pushEnabled: boolean;
  timezone: string;
};

export type AuditEntry = {
  id: string;
  userId: string;
  draftId: string;
  action: "approve" | "reject";
  subject: string;
  createdAt: string;
  before?: string;
  after?: string;
  deliveryStatus?: string;
};

export type DeviceNotification = {
  id: string;
  userId: string;
  packageName: string;
  appName: string;
  title: string;
  body: string;
  postedAt: string;
  receivedAt: string;
};

export type Session = {
  userId: string;
  email: string | null;
  googleConnected: boolean;
  connectionMode: "none" | "google";
  integrationMode: {
    google: "not-configured" | "configured";
    llm: "local" | "configured";
    emailSending: "audit-only" | "gmail-api";
  };
  preferences: Preferences;
};

export type AssistantAnswer = {
  answer: string;
  source: "gemini" | "local";
  generatedAt: string;
};
