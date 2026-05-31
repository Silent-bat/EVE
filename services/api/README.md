# EVE API

This service owns the V1 briefing loop contract:

- Return today's generated briefing
- Approve or reject drafted replies
- Store an audit event for each user action
- Store basic briefing preferences

The first slice uses an in-memory store and the Go standard library. The next
backend step is swapping the store for PostgreSQL/sqlc and adding Google OAuth
token storage behind the same interfaces.

## Run

```bash
go run ./cmd/api
```

## Endpoints

```text
GET  /health
GET  /v1/briefings/today
GET  /v1/audit
GET  /v1/preferences
PUT  /v1/preferences
POST /v1/drafts/{draftID}/action
```

