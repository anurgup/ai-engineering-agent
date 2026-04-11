/**
 * Slack notification utilities.
 * Send DMs to users and messages to channels.
 */

import type { App } from "@slack/bolt";
import type { SlackUser, WorkflowTicket } from "./workflow/types.js";

let slackApp: App | null = null;

export function setSlackApp(app: App): void {
  slackApp = app;
}

// ── Send a DM to a user ───────────────────────────────────────────────────────

export async function notifyUser(slackUserId: string, text: string): Promise<void> {
  if (!slackApp) {
    console.log(`[notifier] DM to ${slackUserId}: ${text.slice(0, 80)}`);
    return;
  }

  try {
    // Open a DM channel then post
    const dm = await slackApp.client.conversations.open({ users: slackUserId });
    const channelId = dm.channel?.id;
    if (!channelId) throw new Error("Could not open DM channel");

    await slackApp.client.chat.postMessage({
      channel: channelId,
      text,
    });
  } catch (err) {
    console.error(`[notifier] Failed to DM ${slackUserId}:`, err);
  }
}

// ── Post to a channel ─────────────────────────────────────────────────────────

export async function notifyChannel(channelName: string, text: string): Promise<void> {
  if (!slackApp) {
    console.log(`[notifier] #${channelName}: ${text.slice(0, 80)}`);
    return;
  }

  try {
    await slackApp.client.chat.postMessage({
      channel: channelName,
      text,
    });
  } catch (err) {
    console.error(`[notifier] Failed to post to #${channelName}:`, err);
  }
}

// ── Look up a Slack user by name ──────────────────────────────────────────────

export async function lookupSlackUser(name: string): Promise<SlackUser | null> {
  if (!slackApp) return null;

  try {
    const result = await slackApp.client.users.list({});
    const members = result.members ?? [];

    const lower = name.toLowerCase();
    const found = members.find(
      (m) =>
        !m.is_bot &&
        !m.deleted &&
        (
          (m.name ?? "").toLowerCase().includes(lower) ||
          (m.real_name ?? "").toLowerCase().includes(lower) ||
          (m.profile?.display_name ?? "").toLowerCase().includes(lower)
        )
    );

    if (!found || !found.id) return null;

    return {
      id:       found.id,
      name:     found.name ?? "",
      realName: found.real_name ?? found.profile?.display_name ?? found.name ?? "",
      role:     "unknown",
    };
  } catch (err) {
    console.error(`[notifier] Failed to lookup user "${name}":`, err);
    return null;
  }
}

// ── Format helpers ────────────────────────────────────────────────────────────

export function slackMention(userId: string): string {
  return `<@${userId}>`;
}

// ── Closure summary — DM every actor when a ticket is closed ─────────────────

/**
 * Sends a rich DM summary to every person who was involved in the ticket:
 * creator, developer, tester, and anyone who triggered a stage change.
 */
export async function sendTicketClosureSummary(ticket: WorkflowTicket): Promise<void> {
  // ── Collect unique human actors ──────────────────────────────────────────
  const actorIds = new Set<string>();

  if (ticket.createdBy)        actorIds.add(ticket.createdBy);
  if (ticket.assigneeSlackId)  actorIds.add(ticket.assigneeSlackId);
  if (ticket.testerSlackId)    actorIds.add(ticket.testerSlackId);

  // Also include anyone who manually triggered a stage change
  for (const event of ticket.history) {
    if (event.changedBy && event.changedBy !== "ai" && event.changedBy !== "system") {
      actorIds.add(event.changedBy);
    }
  }

  if (actorIds.size === 0) return;

  // ── Build timeline ────────────────────────────────────────────────────────
  const timelineLines: string[] = [];
  const stageEmoji: Record<string, string> = {
    backlog: "📋", in_dev: "👨‍💻", in_review: "🔍", in_testing: "🧪", done: "✅", blocked: "🚫",
  };

  for (let i = 0; i < ticket.history.length; i++) {
    const curr = ticket.history[i];
    const next = ticket.history[i + 1];
    const emoji = stageEmoji[curr.stage] ?? "•";
    const label = curr.stage.replace(/_/g, " ").toUpperCase();
    const by    = curr.changedBy === "ai" ? "🤖 AI" : `<@${curr.changedBy}>`;
    const note  = curr.note ? ` — _${curr.note}_` : "";

    let duration = "";
    if (next) {
      const ms   = new Date(next.at).getTime() - new Date(curr.at).getTime();
      duration   = ` _(${formatDuration(ms)})_`;
    }

    timelineLines.push(`${emoji} *${label}*${duration} · by ${by}${note}`);
  }

  // ── Total time ────────────────────────────────────────────────────────────
  const totalMs  = new Date(ticket.updatedAt).getTime() - new Date(ticket.createdAt).getTime();
  const totalStr = formatDuration(totalMs);

  // ── People section ────────────────────────────────────────────────────────
  const peopleLines: string[] = [];
  peopleLines.push(`• 📋 Created by: <@${ticket.createdBy}>`);
  if (ticket.assigneeSlackId) {
    const devName = ticket.assigneeName ?? ticket.assigneeSlackId;
    const devMode = ticket.developerMode === "ai" ? " 🤖 (AI)" : "";
    peopleLines.push(`• 👨‍💻 Developer: <@${ticket.assigneeSlackId}> (${devName})${devMode}`);
  } else if (ticket.developerMode === "ai") {
    peopleLines.push(`• 👨‍💻 Developer: 🤖 AI Agent`);
  }
  if (ticket.testerSlackId) {
    const testName = ticket.testerName ?? ticket.testerSlackId;
    peopleLines.push(`• 🧪 Tester: <@${ticket.testerSlackId}> (${testName})`);
  } else if (ticket.testMode === "ai") {
    peopleLines.push(`• 🧪 Testing: 🤖 AI generated test cases`);
  }

  // ── Links section ─────────────────────────────────────────────────────────
  const linkLines: string[] = [];
  if (ticket.githubUrl) linkLines.push(`• GitHub Issue: <${ticket.githubUrl}|#${ticket.issueNumber}>`);
  if (ticket.prUrl)     linkLines.push(`• Pull Request: <${ticket.prUrl}|PR #${ticket.prNumber ?? ""}>`);
  if (ticket.notionUrl) linkLines.push(`• Documentation: <${ticket.notionUrl}|Notion>`);

  // ── Assemble the message ──────────────────────────────────────────────────
  const summary = [
    `🎉 *Ticket #${ticket.issueNumber} is now CLOSED!*`,
    `*${ticket.title}*`,
    ``,
    `📋 *Journey (total: ${totalStr}):*`,
    ...timelineLines,
    ``,
    `👥 *People involved:*`,
    ...peopleLines,
    ...(linkLines.length > 0 ? [``, `🔗 *Links:*`, ...linkLines] : []),
    ``,
    `Great team effort! 🚀`,
  ].join("\n");

  // ── DM every actor ────────────────────────────────────────────────────────
  const sends = Array.from(actorIds).map((id) => notifyUser(id, summary));
  await Promise.allSettled(sends);

  console.log(`[notifier] Closure summary sent to ${actorIds.size} actor(s) for ticket #${ticket.issueNumber}`);
}

/** Format milliseconds into a human-readable duration string */
function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const mins  = Math.floor(ms / 60_000);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);

  if (days > 0)  return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m`;
}
