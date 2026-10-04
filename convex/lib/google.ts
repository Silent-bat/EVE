/**
 * Google API helpers for Convex
 *
 * Ports Gmail and Calendar API calls from services/api-node/src/google/api.mjs
 */

interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
}

/**
 * List Gmail message IDs in the user's INBOX.
 */
export async function listGmailMessageIds(tokens: GoogleTokens): Promise<string[]> {
  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=500",
    {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Gmail API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return (data.messages || []).map((m: any) => m.id);
}

/**
 * Fetch full message bodies for the given IDs.
 */
export async function fetchGmailMessagesByIds(
  tokens: GoogleTokens,
  ids: string[],
): Promise<any[]> {
  const messages = await Promise.all(
    ids.map(async (id) => {
      const response = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
        {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
          },
        },
      );

      if (!response.ok) {
        console.error(`Failed to fetch message ${id}: ${response.status}`);
        return null;
      }

      return await response.json();
    }),
  );

  return messages.filter(Boolean);
}

/**
 * Fetch upcoming calendar events.
 */
export async function fetchCalendarEvents(
  tokens: GoogleTokens,
  now: Date,
): Promise<any[]> {
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
      `timeMin=${encodeURIComponent(timeMin)}&` +
      `timeMax=${encodeURIComponent(timeMax)}&` +
      `singleEvents=true&` +
      `orderBy=startTime&` +
      `maxResults=20`,
    {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Calendar API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return data.items || [];
}

/**
 * Fetch a single message by id (full format, for the email body endpoint).
 */
export async function fetchGmailMessage(tokens: GoogleTokens, id: string): Promise<any> {
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Gmail API error: ${response.status} ${await response.text()}`);
  }

  return await response.json();
}
