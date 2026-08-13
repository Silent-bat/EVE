/**
 * Pure helpers used by briefing generation.
 *
 * - urgencyScore / urgencyReason: heuristics over subject + body
 * - summarizeMessage: short summary fallback when no LLM is available
 * - localDraft: opinionated reply template for known categories
 * - localMessageAnalysis: assembles the above into the shape the briefing uses
 * - normalizeMessageAnalysis: clamps an LLM-returned analysis to safe bounds
 * - sanitizePlainText: strip stray markup, drop excess whitespace, clamp length
 */
import { stripHTML } from "../google/api.mjs";

/**
 * @param {{ subject: string, body: string }} message
 * @returns {number} 1..99
 */
export function urgencyScore(message) {
  const text = `${message.subject} ${message.body}`.toLowerCase();
  let score = 30;
  if (text.includes("today")) score += 28;
  if (text.includes("noon") || text.includes("before")) score += 24;
  if (text.includes("confirm") || text.includes("needed")) score += 18;
  if (text.includes("investor") || text.includes("contract")) score += 16;
  if (text.includes("invoice")) score -= 10;
  if (text.includes("newsletter")) score -= 25;
  return Math.max(1, Math.min(99, score));
}

/**
 * @param {{ subject: string, body: string }} message
 * @param {number} score
 */
export function urgencyReason(message, score) {
  const text = `${message.subject} ${message.body}`.toLowerCase();
  if (text.includes("noon")) return "Deadline inside the next five hours.";
  if (text.includes("investor")) return "Meeting moved into today's calendar window.";
  if (text.includes("design review")) return "Impacts a meeting already on today's calendar.";
  if (score < 50) return "Informational item, not urgent for today.";
  return "Relevant to today's work and likely needs a response.";
}

/**
 * @param {{ body: string }} message
 */
export function summarizeMessage(message) {
  const body = message.body.replace(/\s+/g, " ").trim();
  return body.length > 150 ? `${body.slice(0, 147)}...` : body;
}

/**
 * @param {{ senderName: string, subject: string }} message
 * @param {number} score
 */
export function localDraft(message, score) {
  const greeting = `Hi ${message.senderName.split(" ")[0]},`;
  if (message.subject.toLowerCase().includes("invoice")) return "No reply needed.";
  if (message.subject.toLowerCase().includes("contract")) {
    return `${greeting} I saw this. I am reviewing the final agreement now and will send the signed version before noon.`;
  }
  if (message.subject.toLowerCase().includes("design review")) {
    return `${greeting} yes, we can move it. I can do 16:30 today if that still works for the team.`;
  }
  if (message.subject.toLowerCase().includes("investor")) {
    return `${greeting} thanks for the heads up. 11:30 works for me, and I will bring the revised deck with the updated retention slide.`;
  }
  if (score < 50) return "No reply needed.";
  return `${greeting} thanks for sending this. I saw it and will follow up today.`;
}

/**
 * @param {{ senderName: string, senderEmail: string, subject: string, body: string }} message
 * @param {number} score
 */
export function localMessageAnalysis(message, score) {
  return {
    urgencyScore: score,
    urgencyReason: urgencyReason(message, score),
    summary: summarizeMessage(message),
    draftReply: localDraft(message, score),
  };
}

/**
 * @param {Partial<{ urgencyScore: number, urgencyReason: string, summary: string, draftReply: string }>} input
 * @param {{ urgencyScore: number, urgencyReason: string, summary: string, draftReply: string }} fallback
 */
export function normalizeMessageAnalysis(input, fallback) {
  return {
    urgencyScore: clampNumber(input.urgencyScore, 1, 99, fallback.urgencyScore),
    urgencyReason: sanitizePlainText(input.urgencyReason, 220) || fallback.urgencyReason,
    summary: sanitizePlainText(input.summary, 420) || fallback.summary,
    draftReply: sanitizePlainText(input.draftReply, 1200) || fallback.draftReply,
  };
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

/**
 * @param {unknown} value
 * @param {number} maxLength
 */
export function sanitizePlainText(value, maxLength) {
  // Belt-and-braces `stripHTML`: bodies are already decoded to plain text
  // upstream, but this is the last gate before a summary is stored and shown,
  // and a summary that leaks markup is the single most visible way for this to
  // go wrong. Also covers the LLM echoing markup back from a body it was given.
  return stripHTML(String(value || "")).slice(0, maxLength);
}

/**
 * @param {unknown} value
 */
export function validDateISOString(value) {
  const date = new Date(/** @type {string} */ (value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
