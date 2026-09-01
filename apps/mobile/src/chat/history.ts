import type { AssistantAnswer } from "../types";

const NAMESPACE = "eve.chat-history.v1";
const MAX_CONVERSATIONS = 24;
const MAX_TURNS = 100;
// Chat transcripts are private content. Keep them in memory for the current
// session rather than persisting plaintext copies in AsyncStorage/backups.
const historyByUser = new Map<string, ChatConversation[]>();

export type ChatTurn = {
  id: string;
  prompt: string;
  answer: AssistantAnswer | null;
  error: string | null;
  createdAt: string;
};

export type ChatConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ChatTurn[];
};

function storageKey(userID: string): string {
  return `${NAMESPACE}.${userID}`;
}

export function conversationTitle(prompt: string): string {
  const compact = prompt.trim().replace(/\s+/g, " ");
  return compact.length > 46 ? `${compact.slice(0, 43)}...` : compact || "New conversation";
}

export async function readChatHistory(userID: string): Promise<ChatConversation[]> {
  if (!userID) return [];
  return (historyByUser.get(storageKey(userID)) || []).map((conversation) => ({
    ...conversation,
    turns: conversation.turns.slice(-MAX_TURNS),
  }));
}

export async function writeChatHistory(userID: string, conversations: ChatConversation[]): Promise<void> {
  if (!userID) return;

  const bounded = conversations
    .filter((conversation) => conversation.turns.length > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_CONVERSATIONS)
    .map((conversation) => ({ ...conversation, turns: conversation.turns.slice(-MAX_TURNS) }));
  historyByUser.set(storageKey(userID), bounded);
}

export async function clearAllChatHistory(): Promise<void> {
  historyByUser.clear();
}
