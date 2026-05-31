package briefing

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

var (
	ErrDraftNotFound = errors.New("draft not found")
	ErrInvalidAction = errors.New("invalid action")
	ErrAlreadyClosed = errors.New("draft already approved or rejected")
)

type Store interface {
	Today(ctx context.Context, userID string) (Briefing, error)
	Audit(ctx context.Context, userID string) ([]AuditEntry, error)
	Preferences(ctx context.Context, userID string) (Preferences, error)
	UpdatePreferences(ctx context.Context, prefs Preferences) (Preferences, error)
	ActOnDraft(ctx context.Context, userID string, draftID string, input ActionInput) (EmailDraft, AuditEntry, error)
}

type MemoryStore struct {
	mu          sync.RWMutex
	briefings   map[string]Briefing
	audit       map[string][]AuditEntry
	preferences map[string]Preferences
}

func NewMemoryStore(now time.Time) *MemoryStore {
	userID := "demo-user"
	generatedAt := time.Date(now.Year(), now.Month(), now.Day(), 7, 45, 0, 0, time.Local)

	store := &MemoryStore{
		briefings:   make(map[string]Briefing),
		audit:       make(map[string][]AuditEntry),
		preferences: make(map[string]Preferences),
	}

	store.briefings[userID] = Briefing{
		ID:          fmt.Sprintf("briefing-%s", generatedAt.Format("2006-01-02")),
		UserID:      userID,
		GeneratedAt: generatedAt,
		Emails: []EmailDraft{
			{
				ID:            "draft-1",
				ThreadID:      "thread-investor-update",
				SenderName:    "Maya Chen",
				SenderEmail:   "maya@northstar.vc",
				Subject:       "Investor update call moved to today",
				ReceivedAt:    generatedAt.Add(-33 * time.Minute),
				UrgencyScore:  94,
				UrgencyReason: "Meeting moved into today's calendar window.",
				Summary:       "Maya moved the investor update call to 11:30 and asked you to confirm the revised deck is ready.",
				DraftReply:    "Hi Maya, thanks for the heads up. 11:30 works for me, and I will bring the revised deck with the updated retention slide.",
				Status:        EmailStatusPending,
			},
			{
				ID:            "draft-2",
				ThreadID:      "thread-contract-signature",
				SenderName:    "Jordan Lee",
				SenderEmail:   "jordan@atlasops.co",
				Subject:       "Contract signature needed before noon",
				ReceivedAt:    generatedAt.Add(-57 * time.Minute),
				UrgencyScore:  89,
				UrgencyReason: "Deadline inside the next five hours.",
				Summary:       "Jordan needs the final service agreement signed before noon so the onboarding window does not slip.",
				DraftReply:    "Hi Jordan, I saw this. I am reviewing the final agreement now and will send the signed version before noon.",
				Status:        EmailStatusPending,
			},
			{
				ID:            "draft-3",
				ThreadID:      "thread-design-review",
				SenderName:    "Nadia Okafor",
				SenderEmail:   "nadia@forge.team",
				Subject:       "Can we move the design review?",
				ReceivedAt:    generatedAt.Add(-84 * time.Minute),
				UrgencyScore:  77,
				UrgencyReason: "Impacts a meeting already on today's calendar.",
				Summary:       "Nadia has a client conflict and asked to move the 15:00 design review to a later slot today.",
				DraftReply:    "Hi Nadia, yes, we can move it. I can do 16:30 today if that still works for the team.",
				Status:        EmailStatusPending,
			},
		},
		Calendar: []CalendarEvent{
			{
				ID:       "cal-1",
				Title:    "Product standup",
				StartsAt: sameDay(generatedAt, 9, 0),
				EndsAt:   sameDay(generatedAt, 9, 30),
				Location: "Google Meet",
			},
			{
				ID:       "cal-2",
				Title:    "Investor update",
				StartsAt: sameDay(generatedAt, 11, 30),
				EndsAt:   sameDay(generatedAt, 12, 0),
				Location: "Zoom",
			},
			{
				ID:       "cal-3",
				Title:    "Design review",
				StartsAt: sameDay(generatedAt, 15, 0),
				EndsAt:   sameDay(generatedAt, 16, 0),
				Location: "Office",
			},
		},
	}

	briefing := store.briefings[userID]
	briefing.Stats = calculateStats(briefing)
	store.briefings[userID] = briefing

	store.preferences[userID] = Preferences{
		UserID:        userID,
		BriefingTime: "08:00",
		PushEnabled:  true,
		Timezone:     "Africa/Douala",
	}

	return store
}

func (s *MemoryStore) Today(_ context.Context, userID string) (Briefing, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	briefing, ok := s.briefings[userID]
	if !ok {
		return Briefing{}, fmt.Errorf("briefing for %s: %w", userID, ErrDraftNotFound)
	}
	briefing.Stats = calculateStats(briefing)
	return briefing, nil
}

func (s *MemoryStore) Audit(_ context.Context, userID string) ([]AuditEntry, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	entries := append([]AuditEntry(nil), s.audit[userID]...)
	return entries, nil
}

func (s *MemoryStore) Preferences(_ context.Context, userID string) (Preferences, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	prefs, ok := s.preferences[userID]
	if !ok {
		return Preferences{UserID: userID, BriefingTime: "08:00", PushEnabled: true, Timezone: "UTC"}, nil
	}
	return prefs, nil
}

func (s *MemoryStore) UpdatePreferences(_ context.Context, prefs Preferences) (Preferences, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if prefs.UserID == "" {
		prefs.UserID = "demo-user"
	}
	if prefs.BriefingTime == "" {
		prefs.BriefingTime = "08:00"
	}
	if prefs.Timezone == "" {
		prefs.Timezone = "UTC"
	}

	s.preferences[prefs.UserID] = prefs
	return prefs, nil
}

func (s *MemoryStore) ActOnDraft(_ context.Context, userID string, draftID string, input ActionInput) (EmailDraft, AuditEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if input.Action != ActionApprove && input.Action != ActionReject {
		return EmailDraft{}, AuditEntry{}, ErrInvalidAction
	}

	briefing, ok := s.briefings[userID]
	if !ok {
		return EmailDraft{}, AuditEntry{}, ErrDraftNotFound
	}

	for index, draft := range briefing.Emails {
		if draft.ID != draftID {
			continue
		}

		if draft.Status != EmailStatusPending {
			return EmailDraft{}, AuditEntry{}, ErrAlreadyClosed
		}

		before := draft.DraftReply
		if input.DraftReply != "" {
			draft.DraftReply = input.DraftReply
		}
		if input.Action == ActionApprove {
			draft.Status = EmailStatusApproved
		} else {
			draft.Status = EmailStatusRejected
		}

		briefing.Emails[index] = draft
		briefing.Stats = calculateStats(briefing)
		s.briefings[userID] = briefing

		entry := AuditEntry{
			ID:        fmt.Sprintf("audit-%d", time.Now().UnixNano()),
			UserID:    userID,
			DraftID:   draft.ID,
			Action:    input.Action,
			Subject:   draft.Subject,
			CreatedAt: time.Now().UTC(),
			Before:    before,
			After:     draft.DraftReply,
		}
		s.audit[userID] = append(s.audit[userID], entry)

		return draft, entry, nil
	}

	return EmailDraft{}, AuditEntry{}, ErrDraftNotFound
}

func calculateStats(briefing Briefing) BriefingStats {
	stats := BriefingStats{
		MeetingsToday: len(briefing.Calendar),
	}

	for _, draft := range briefing.Emails {
		if draft.UrgencyScore >= 75 {
			stats.PriorityEmails++
		}
		if draft.Status == EmailStatusApproved {
			stats.ApprovedReplies++
		}
	}

	return stats
}

func sameDay(base time.Time, hour int, minute int) time.Time {
	return time.Date(base.Year(), base.Month(), base.Day(), hour, minute, 0, 0, base.Location())
}

