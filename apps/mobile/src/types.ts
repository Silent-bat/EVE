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

/**
 * One whole email, fetched on demand from `/v1/emails/:id/body`.
 *
 * Extends the list shape rather than replacing it: the detail view already has
 * the summary fields when it opens, and the body is the only thing it waits
 * for. `bodyAvailable` false is not an error — it means Gmail wouldn't give up
 * the text (usually because it isn't connected), and `reason` says why.
 */
export type EmailBody = BriefingEmail & {
  body: string;
  bodyAvailable: boolean;
  reason?: string;
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

export type ProactiveCategoryName =
  | "urgent_email"
  | "interview_prep"
  | "project_checkin"
  | "brainstorm_idea"
  | "briefing_ready";

export type ProactiveUrgency = "low" | "medium" | "high" | "critical";

export type ProactiveDeliveryMode = "silent" | "soft" | "push";

export type ProactiveCategoryPrefs = {
  enabled: boolean;
  threshold: ProactiveUrgency;
  deliveryMode: ProactiveDeliveryMode;
};

export type ProactiveAvailableNow = {
  until: string;
  categories: ProactiveCategoryName[];
  reason: string;
};

export type ProactivePreferences = {
  enabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  maxPushesPerDay: number;
  maxPushesPerHour: number;
  categories: Record<ProactiveCategoryName, ProactiveCategoryPrefs>;
  availableNow: ProactiveAvailableNow | null;
};

export type ProactiveThoughtStatus = "new" | "seen" | "dismissed" | "acted_on";

export type ProactiveThoughtFeedback = "helpful" | "not_now" | "never_again" | null;

export type ProactiveThought = {
  id: string;
  userId: string;
  category: ProactiveCategoryName;
  urgency: ProactiveUrgency;
  title: string;
  body: string;
  data: Record<string, unknown>;
  createdAt: string;
  status: ProactiveThoughtStatus;
  pushed: boolean;
  pushedAt: string | null;
  feedback: ProactiveThoughtFeedback;
  feedbackAt: string | null;
  pushSuppressedReason: string | null;
};

export type Preferences = {
  userId: string;
  briefingTime: string;
  pushEnabled: boolean;
  timezone: string;
  proactive?: ProactivePreferences;
};

export type UserProfile = {
  role: string;
  industry: string;
  currentProjects: string;
  keyRelationships: string;
  goals: string;
  communicationStyle: string;
};

export type BriefingRange = "day" | "week" | "month";

export type TaskStatus = "open" | "done";

export type TaskPriority = "low" | "normal" | "high";

/**
 * A task EVE is tracking. `source` records where it came from: `eve` for
 * something she inferred from mail or a conversation, `user` for something
 * typed directly. The UI shows that authorship, so a user is never left
 * wondering why a task they don't remember writing is on their list.
 */
export type Task = {
  id: string;
  userId: string;
  title: string;
  notes: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  createdAt: string;
  completedAt: string | null;
  source: "eve" | "user";
  /** Set when EVE derived the task from a specific email. */
  sourceEmailId: string | null;
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
  /** Google's display name. Null for password accounts, or when Google omits it. */
  displayName?: string | null;
  /** Google profile photo URL. Null when the account has no photo. */
  photoURL?: string | null;
  googleConnected: boolean;
  connectionMode: "none" | "google";
  /**
   * Whether this account has a password at all. Google-only accounts don't, so
   * the change-password control is hidden rather than shown and made to fail.
   */
  hasPassword?: boolean;
  integrationMode: {
    google: "not-configured" | "configured";
    llm: "local" | "configured";
    emailSending: "audit-only" | "gmail-api";
  };
  preferences: Preferences;
};

export type AssistantAction = {
  name: string;
  args: Record<string, unknown>;
};

export type AssistantAnswer = {
  answer: string;
  source: "gemini" | "local";
  generatedAt: string;
  action?: AssistantAction;
  result?: unknown;
};
