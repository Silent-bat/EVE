package httpapi

import (
	"log/slog"
	"net/http"

	"eve/services/api/internal/briefing"
)

type Server struct {
	store  briefing.Store
	logger *slog.Logger
}

func NewServer(store briefing.Store, logger *slog.Logger) *Server {
	return &Server{store: store, logger: logger}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /v1/briefings/today", s.todayBriefing)
	mux.HandleFunc("GET /v1/audit", s.audit)
	mux.HandleFunc("GET /v1/preferences", s.preferences)
	mux.HandleFunc("PUT /v1/preferences", s.updatePreferences)
	mux.HandleFunc("POST /v1/drafts/{draftID}/action", s.actOnDraft)

	return s.withCORS(s.withLogging(mux))
}

func (s *Server) withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		s.logger.Info("request", "method", request.Method, "path", request.URL.Path)
		next.ServeHTTP(response, request)
	})
}

func (s *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Access-Control-Allow-Origin", "*")
		response.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		response.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")

		if request.Method == http.MethodOptions {
			response.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(response, request)
	})
}

