const STORAGE_KEY = "eve.preview.state";

const initialState = {
  connected: false,
  tab: "briefing",
  selectedEmailId: "draft-1",
  editingEmailId: null,
  preferences: {
    briefingTime: "08:00",
    pushEnabled: true,
  },
  audit: [],
  briefing: {
    generatedAt: "2026-05-27T07:45:00+01:00",
    emails: [
      {
        id: "draft-1",
        senderName: "Maya Chen",
        senderEmail: "maya@northstar.vc",
        subject: "Investor update call moved to today",
        receivedAt: "07:12",
        score: 94,
        reason: "Meeting moved into today's calendar window.",
        summary:
          "Maya moved the investor update call to 11:30 and asked you to confirm the revised deck is ready.",
        draft:
          "Hi Maya, thanks for the heads up. 11:30 works for me, and I will bring the revised deck with the updated retention slide.",
        status: "pending",
      },
      {
        id: "draft-2",
        senderName: "Jordan Lee",
        senderEmail: "jordan@atlasops.co",
        subject: "Contract signature needed before noon",
        receivedAt: "06:48",
        score: 89,
        reason: "Deadline inside the next five hours.",
        summary:
          "Jordan needs the final service agreement signed before noon so the onboarding window does not slip.",
        draft:
          "Hi Jordan, I saw this. I am reviewing the final agreement now and will send the signed version before noon.",
        status: "pending",
      },
      {
        id: "draft-3",
        senderName: "Nadia Okafor",
        senderEmail: "nadia@forge.team",
        subject: "Can we move the design review?",
        receivedAt: "06:21",
        score: 77,
        reason: "Impacts a meeting already on today's calendar.",
        summary:
          "Nadia has a client conflict and asked to move the 15:00 design review to a later slot today.",
        draft:
          "Hi Nadia, yes, we can move it. I can do 16:30 today if that still works for the team.",
        status: "pending",
      },
      {
        id: "draft-4",
        senderName: "CloudDesk",
        senderEmail: "billing@clouddesk.example",
        subject: "May workspace invoice available",
        receivedAt: "05:54",
        score: 42,
        reason: "Finance item, not urgent for today.",
        summary:
          "Your May invoice is available. No action is required unless you need it for accounting.",
        draft:
          "No reply needed.",
        status: "pending",
      },
    ],
    calendar: [
      {
        id: "cal-1",
        time: "09:00",
        title: "Product standup",
        location: "Google Meet",
      },
      {
        id: "cal-2",
        time: "11:30",
        title: "Investor update",
        location: "Zoom",
      },
      {
        id: "cal-3",
        time: "15:00",
        title: "Design review",
        location: "Office",
      },
      {
        id: "cal-4",
        time: "17:30",
        title: "Hiring sync",
        location: "Google Meet",
      },
    ],
  },
};

let state = loadState();

function loadState() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored ? { ...initialState, ...JSON.parse(stored) } : initialState;
  } catch {
    return initialState;
  }
}

function saveState() {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function icon(name) {
  const icons = {
    mail:
      '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M4 6h16v12H4z"/><path d="m4 7 8 6 8-6"/></svg>',
    calendar:
      '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M7 3v4M17 3v4M4 9h16"/><path d="M5 5h14v15H5z"/></svg>',
    shield:
      '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6z"/><path d="m9 12 2 2 4-5"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="m5 12 4 4L19 6"/></svg>',
    edit:
      '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    x:
      '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    bell:
      '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>',
  };
  return icons[name] || "";
}

function initials(name) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function pendingEmails() {
  return state.briefing.emails.filter((email) => email.status === "pending");
}

function approvedEmails() {
  return state.briefing.emails.filter((email) => email.status === "approved");
}

function todayLabel() {
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(state.briefing.generatedAt));
}

function render() {
  const app = document.querySelector("#app");

  if (!state.connected) {
    app.innerHTML = renderConnect();
    bindConnectEvents();
    return;
  }

  app.innerHTML = `
    <div class="screen">
      ${renderTopbar()}
      <section class="content">
        ${state.tab === "briefing" ? renderBriefing() : ""}
        ${state.tab === "approvals" ? renderApprovals() : ""}
        ${state.tab === "audit" ? renderAudit() : ""}
        ${state.tab === "settings" ? renderSettings() : ""}
      </section>
    </div>
  `;

  bindAppEvents();
}

function renderConnect() {
  return `
    <section class="connect-screen">
      <div class="connect-hero">
        <div class="connect-mark">E</div>
        <h1 class="connect-title">Your morning brief, ready before work.</h1>
        <p class="connect-copy">Connect Google to let EVE prepare priority emails, today's meetings, and drafted replies for approval.</p>
      </div>

      <div class="permission-list">
        <div class="permission-row">
          <span class="icon">${icon("mail")}</span>
          <div>
            <div class="permission-title">Gmail</div>
            <div class="permission-body">Read recent messages and prepare reply drafts. EVE cannot send without approval.</div>
          </div>
        </div>
        <div class="permission-row">
          <span class="icon">${icon("calendar")}</span>
          <div>
            <div class="permission-title">Google Calendar</div>
            <div class="permission-body">Read today's events so urgent mail is ranked against your schedule.</div>
          </div>
        </div>
        <div class="permission-row">
          <span class="icon">${icon("shield")}</span>
          <div>
            <div class="permission-title">Human approval</div>
            <div class="permission-body">Every outgoing action is logged and requires a tap from you.</div>
          </div>
        </div>
      </div>

      <button class="primary-button" data-action="connect">
        <span class="icon" aria-hidden="true">${icon("check")}</span>
        Connect Google
      </button>
    </section>
  `;
}

function renderTopbar() {
  return `
    <header class="topbar">
      <div class="topbar-main">
        <div class="brand">
          <div class="mark">E</div>
          <div class="title-group">
            <h1 class="app-name">EVE</h1>
            <p class="subline">${todayLabel()} - briefing at ${state.preferences.briefingTime}</p>
          </div>
        </div>
        <span class="status-pill"><span class="status-dot"></span>${pendingEmails().length} pending</span>
      </div>
      <nav class="tabs" aria-label="Primary">
        ${renderTab("briefing", "Briefing")}
        ${renderTab("approvals", "Approve")}
        ${renderTab("audit", "Audit")}
        ${renderTab("settings", "Settings")}
      </nav>
    </header>
  `;
}

function renderTab(tab, label) {
  const active = state.tab === tab ? " active" : "";
  return `<button class="tab${active}" data-tab="${tab}">${label}</button>`;
}

function renderBriefing() {
  const urgent = state.briefing.emails.filter((email) => email.score >= 75).length;
  return `
    <div class="summary-band">
      <div class="metric">
        <div class="metric-value">${urgent}</div>
        <div class="metric-label">priority emails</div>
      </div>
      <div class="metric">
        <div class="metric-value">${state.briefing.calendar.length}</div>
        <div class="metric-label">meetings today</div>
      </div>
      <div class="metric">
        <div class="metric-value">${approvedEmails().length}</div>
        <div class="metric-label">approved replies</div>
      </div>
    </div>

    <div class="section-heading">
      <h2>Priority inbox</h2>
      <span class="small-note">${pendingEmails().length} awaiting review</span>
    </div>
    <div class="email-list">
      ${state.briefing.emails
        .slice()
        .sort((a, b) => b.score - a.score)
        .map((email) => renderEmailCard(email, false))
        .join("")}
    </div>

    <div class="section-heading">
      <h2>Calendar</h2>
      <span class="small-note">Today</span>
    </div>
    ${renderCalendar()}
  `;
}

function renderApprovals() {
  const selected =
    state.briefing.emails.find((email) => email.id === state.selectedEmailId) ||
    state.briefing.emails[0];

  return `
    <div class="section-heading">
      <h2>Reply approvals</h2>
      <span class="small-note">${pendingEmails().length} remaining</span>
    </div>

    <div class="email-list">
      ${state.briefing.emails.map((email) => renderEmailCard(email, true)).join("")}
    </div>

    ${selected ? renderDraftPanel(selected) : ""}
  `;
}

function renderEmailCard(email, selectable) {
  const selected = selectable && state.selectedEmailId === email.id ? " selected" : "";
  const tag = selectable ? "button" : "article";
  const data = selectable ? `data-select-email="${email.id}"` : "";

  return `
    <${tag} class="email-card${selected}" ${data}>
      <div class="email-topline">
        <div class="sender">
          <div class="avatar">${initials(email.senderName)}</div>
          <div>
            <div class="sender-name">${email.senderName}</div>
            <div class="email-meta">${email.receivedAt} - ${email.senderEmail}</div>
          </div>
        </div>
        <span class="status ${email.status}">${email.status}</span>
      </div>
      <div>
        <div class="email-subject">${email.subject}</div>
        <div class="email-summary">${email.summary}</div>
      </div>
      <div class="score-row" aria-label="Urgency score ${email.score}">
        <div class="score-track"><div class="score-fill" style="width: ${email.score}%"></div></div>
        <div class="score-label">${email.score}</div>
      </div>
      <div class="email-meta">${email.reason}</div>
    </${tag}>
  `;
}

function renderDraftPanel(email) {
  const editing = state.editingEmailId === email.id;
  const locked = email.status !== "pending";
  const draft = escapeHtml(email.draft);

  return `
    <section class="draft-panel">
      <div class="section-heading">
        <h2>Draft reply</h2>
        <span class="small-note">${email.senderName}</span>
      </div>
      ${
        editing
          ? `<textarea class="draft-editor" data-editor="${email.id}">${draft}</textarea>`
          : `<p class="draft-text">${draft}</p>`
      }
      ${
        locked
          ? `<div class="empty-state">This item is already ${email.status}.</div>`
          : renderDraftActions(email, editing)
      }
    </section>
  `;
}

function renderDraftActions(email, editing) {
  if (editing) {
    return `
      <div class="actions editing">
        <button class="secondary-button" data-action="save-approve" data-email-id="${email.id}">
          <span class="icon" aria-hidden="true">${icon("check")}</span>
          Save and approve
        </button>
        <button class="quiet-button" data-action="cancel-edit" data-email-id="${email.id}">Cancel</button>
      </div>
    `;
  }

  return `
    <div class="actions">
      <button class="secondary-button" data-action="approve" data-email-id="${email.id}">
        <span class="icon" aria-hidden="true">${icon("check")}</span>
        Approve
      </button>
      <button class="quiet-button" data-action="edit" data-email-id="${email.id}">
        <span class="icon" aria-hidden="true">${icon("edit")}</span>
        Edit
      </button>
      <button class="danger-button" data-action="reject" data-email-id="${email.id}">
        <span class="icon" aria-hidden="true">${icon("x")}</span>
        Reject
      </button>
    </div>
  `;
}

function renderCalendar() {
  return `
    <div class="calendar-list">
      ${state.briefing.calendar
        .map(
          (event) => `
            <div class="calendar-row">
              <div class="event-time">${event.time}</div>
              <div class="calendar-main">
                <div class="row-title">${event.title}</div>
                <div class="row-body">${event.location}</div>
              </div>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderAudit() {
  const entries = state.audit.slice().reverse();

  return `
    <div class="section-heading">
      <h2>Audit log</h2>
      <span class="small-note">${entries.length} actions</span>
    </div>
    ${
      entries.length === 0
        ? `<div class="empty-state">No approved or rejected replies yet.</div>`
        : `<div class="audit-list">${entries
            .map(
              (entry) => `
                <div class="audit-row">
                  <div class="audit-time">${entry.time}</div>
                  <div class="audit-main">
                    <div class="row-title">${entry.action}</div>
                    <div class="row-body">${entry.subject}</div>
                  </div>
                </div>
              `,
            )
            .join("")}</div>`
    }
  `;
}

function renderSettings() {
  return `
    <div class="section-heading">
      <h2>Preferences</h2>
      <span class="small-note">Daily briefing</span>
    </div>
    <div class="settings-panel">
      <div class="setting-row">
        <span class="icon">${icon("bell")}</span>
        <div class="setting-main">
          <div class="row-title">Briefing time</div>
          <div class="row-body">Push arrives after the server job completes.</div>
        </div>
        <input class="time-input" type="time" value="${state.preferences.briefingTime}" data-setting="briefingTime">
      </div>
      <div class="setting-row">
        <span class="icon">${icon("mail")}</span>
        <div class="setting-main">
          <div class="row-title">Push notifications</div>
          <div class="row-body">Morning briefing and approved action receipts.</div>
        </div>
        <label class="switch">
          <input type="checkbox" data-setting="pushEnabled" ${state.preferences.pushEnabled ? "checked" : ""}>
          <span></span>
        </label>
      </div>
    </div>
    <button class="quiet-button" data-action="reset" style="width: 100%; margin-top: 24px;">Reset demo</button>
  `;
}

function bindConnectEvents() {
  document.querySelector('[data-action="connect"]').addEventListener("click", () => {
    state = { ...state, connected: true };
    saveState();
    render();
  });
}

function bindAppEvents() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state = { ...state, tab: button.dataset.tab };
      saveState();
      render();
    });
  });

  document.querySelectorAll("[data-select-email]").forEach((button) => {
    button.addEventListener("click", () => {
      state = {
        ...state,
        selectedEmailId: button.dataset.selectEmail,
        editingEmailId: null,
      };
      saveState();
      render();
    });
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleAction(button));
  });

  document.querySelectorAll("[data-setting]").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.setting;
      const value = input.type === "checkbox" ? input.checked : input.value;
      state = {
        ...state,
        preferences: { ...state.preferences, [key]: value },
      };
      saveState();
      render();
    });
  });
}

function handleAction(button) {
  const action = button.dataset.action;
  const emailId = button.dataset.emailId;

  if (action === "reset") {
    window.localStorage.removeItem(STORAGE_KEY);
    state = structuredClone(initialState);
    render();
    return;
  }

  if (action === "edit") {
    state = { ...state, editingEmailId: emailId };
    saveState();
    render();
    return;
  }

  if (action === "cancel-edit") {
    state = { ...state, editingEmailId: null };
    saveState();
    render();
    return;
  }

  if (action === "approve") {
    updateEmail(emailId, "approved");
    return;
  }

  if (action === "reject") {
    updateEmail(emailId, "rejected");
    return;
  }

  if (action === "save-approve") {
    const editor = document.querySelector(`[data-editor="${emailId}"]`);
    updateEmail(emailId, "approved", editor.value.trim());
  }
}

function updateEmail(emailId, status, nextDraft) {
  const email = state.briefing.emails.find((item) => item.id === emailId);
  if (!email || email.status !== "pending") return;

  const action = status === "approved" ? "Approved reply" : "Rejected reply";
  const time = new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

  state = {
    ...state,
    editingEmailId: null,
    briefing: {
      ...state.briefing,
      emails: state.briefing.emails.map((item) =>
        item.id === emailId
          ? { ...item, status, draft: nextDraft || item.draft }
          : item,
      ),
    },
    audit: [
      ...state.audit,
      {
        id: `audit-${Date.now()}`,
        time,
        action,
        subject: email.subject,
      },
    ],
  };

  const nextPending = state.briefing.emails.find((item) => item.status === "pending");
  state.selectedEmailId = nextPending ? nextPending.id : emailId;

  saveState();
  render();
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

render();
