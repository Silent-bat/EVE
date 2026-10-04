/**
 * Convex Cron Jobs
 *
 * Scheduled functions that run periodically.
 * Deploy with: npx convex deploy
 */
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * Gmail polling cron: runs every 15 minutes.
 *
 * Sweeps all Google-connected users and polls Gmail for new messages.
 * Each user is polled at most once per 15-minute window (tracked via
 * gmailPoll.lastPollAt in the user record).
 *
 * This replaces the Node.js setInterval loop in
 * services/api-node/src/briefing/gmail-poller.mjs.
 */
crons.interval(
  "gmail-poller",
  { minutes: 15 },
  internal.gmail.sweepGmailPollers,
);

export default crons;
