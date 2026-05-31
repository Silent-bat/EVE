package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"eve/services/api/internal/briefing"
)

const demoUserID = "demo-user"

func (s *Server) health(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) todayBriefing(response http.ResponseWriter, request *http.Request) {
	result, err := s.store.Today(request.Context(), userID(request))
	if err != nil {
		writeError(response, http.StatusNotFound, err)
		return
	}

	writeJSON(response, http.StatusOK, result)
}

func (s *Server) audit(response http.ResponseWriter, request *http.Request) {
	entries, err := s.store.Audit(request.Context(), userID(request))
	if err != nil {
		writeError(response, http.StatusInternalServerError, err)
		return
	}

	writeJSON(response, http.StatusOK, map[string][]briefing.AuditEntry{"entries": entries})
}

func (s *Server) preferences(response http.ResponseWriter, request *http.Request) {
	prefs, err := s.store.Preferences(request.Context(), userID(request))
	if err != nil {
		writeError(response, http.StatusInternalServerError, err)
		return
	}

	writeJSON(response, http.StatusOK, prefs)
}

func (s *Server) updatePreferences(response http.ResponseWriter, request *http.Request) {
	var prefs briefing.Preferences
	if err := json.NewDecoder(request.Body).Decode(&prefs); err != nil {
		writeError(response, http.StatusBadRequest, err)
		return
	}

	prefs.UserID = userID(request)
	result, err := s.store.UpdatePreferences(request.Context(), prefs)
	if err != nil {
		writeError(response, http.StatusInternalServerError, err)
		return
	}

	writeJSON(response, http.StatusOK, result)
}

func (s *Server) actOnDraft(response http.ResponseWriter, request *http.Request) {
	var input briefing.ActionInput
	if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
		writeError(response, http.StatusBadRequest, err)
		return
	}

	draftID := request.PathValue("draftID")
	draft, entry, err := s.store.ActOnDraft(request.Context(), userID(request), draftID, input)
	if err != nil {
		switch {
		case errors.Is(err, briefing.ErrInvalidAction):
			writeError(response, http.StatusBadRequest, err)
		case errors.Is(err, briefing.ErrAlreadyClosed):
			writeError(response, http.StatusConflict, err)
		default:
			writeError(response, http.StatusNotFound, err)
		}
		return
	}

	writeJSON(response, http.StatusOK, map[string]any{
		"draft": draft,
		"audit": entry,
	})
}

func userID(request *http.Request) string {
	header := request.Header.Get("X-EVE-User-ID")
	if header != "" {
		return header
	}
	return demoUserID
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, err error) {
	writeJSON(response, status, map[string]string{"error": err.Error()})
}

