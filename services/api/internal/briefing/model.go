package briefing

import "time"

type EmailStatus string

const (
	EmailStatusPending  EmailStatus = "pending"
	EmailStatusApproved EmailStatus = "approved"
	EmailStatusRejected EmailStatus = "rejected"
)

type ActionType string

const (
	ActionApprove ActionType = "approve"
	ActionReject  ActionType = "reject"
)

type Briefing struct {
	ID          string          `json:"id"`
	UserID      string          `json:"userId"`
	GeneratedAt time.Time       `json:"generatedAt"`
	Stats       BriefingStats   `json:"stats"`
	Emails      []EmailDraft    `json:"emails"`
	Calendar    []CalendarEvent `json:"calendar"`
}

type BriefingStats struct {
	PriorityEmails  int `json:"priorityEmails"`
	MeetingsToday   int `json:"meetingsToday"`
	ApprovedReplies int `json:"approvedReplies"`
}

type EmailDraft struct {
	ID            string      `json:"id"`
	ThreadID      string      `json:"threadId"`
	SenderName    string      `json:"senderName"`
	SenderEmail   string      `json:"senderEmail"`
	Subject       string      `json:"subject"`
	ReceivedAt    time.Time   `json:"receivedAt"`
	UrgencyScore  int         `json:"urgencyScore"`
	UrgencyReason string      `json:"urgencyReason"`
	Summary       string      `json:"summary"`
	DraftReply    string      `json:"draftReply"`
	Status        EmailStatus `json:"status"`
}

type CalendarEvent struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	StartsAt time.Time `json:"startsAt"`
	EndsAt   time.Time `json:"endsAt"`
	Location string    `json:"location"`
}

type AuditEntry struct {
	ID        string     `json:"id"`
	UserID    string     `json:"userId"`
	DraftID   string     `json:"draftId"`
	Action    ActionType `json:"action"`
	Subject   string     `json:"subject"`
	CreatedAt time.Time  `json:"createdAt"`
	Before    string     `json:"before,omitempty"`
	After     string     `json:"after,omitempty"`
}

type Preferences struct {
	UserID        string `json:"userId"`
	BriefingTime string `json:"briefingTime"`
	PushEnabled  bool   `json:"pushEnabled"`
	Timezone     string `json:"timezone"`
}

type ActionInput struct {
	Action     ActionType `json:"action"`
	DraftReply string     `json:"draftReply"`
}

