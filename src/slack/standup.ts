/**
 * Daily standup bot.
 * Posts a morning summary every weekday at 9am.
 * Call scheduleStandup() once at startup.
 */

import { getAllTickets, getTicketsByStage } from "./workflow/store.js";
import { notifyChannel } from "./notifier.js";
import type { WorkflowTicket, TicketStage } from "./workflow/types.js";

const STATUS_CHANNEL = process.env.SLACK_STATUS_CHANNEL ?? "general";

const STAGE_EMOJI: Record<TicketStage, string> = {
  backlog:    "📋",
  in_dev:     "👨‍💻",
  in_review:  "🔍",
  in_testing: "🧪",
  done:       "✅",
  blocked:    "🚫",
};

export function buildStandupMessage(): string {
  const tickets = getAllTickets();

  const backlog    = tickets.filter((t) => t.stage === "backlog");
  const inDev      = tickets.filter((t) => t.stage === "in_dev");
  const inReview   = tickets.filter((t) => t.stage === "in_review");
  const inTesting  = tickets.filter((t) => t.stage === "in_testing");
  const doneToday  = tickets.filter((t) => t.stage === "done" && isToday(t.updatedAt));
  const blocked    = tickets.filter((t) => t.stage === "blocked");

  const lines: string[] = [
    `🌅 *Good morning! Here's today's engineering standup*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
  ];

  if (doneToday.length > 0) {
    lines.push(`\n✅ *Completed yesterday/today (${doneToday.length})*`);
    doneToday.forEach((t) => lines.push(`  • #${t.issueNumber}: ${t.title}`));
  }

  if (inDev.length > 0) {
    lines.push(`\n👨‍💻 *In Development (${inDev.length})*`);
    inDev.forEach((t) => {
      const who = t.developerMode === "ai" ? "🤖 AI" : t.assigneeName ?? "Unassigned";
      const age = hoursAgo(t.stageChangedAt);
      lines.push(`  • #${t.issueNumber}: ${t.title} — ${who} (${age}h ago)`);
    });
  }

  if (inReview.length > 0) {
    lines.push(`\n🔍 *In Review (${inReview.length})*`);
    inReview.forEach((t) => {
      const age = hoursAgo(t.stageChangedAt);
      lines.push(`  • #${t.issueNumber}: ${t.title} (${age}h in review)`);
    });
  }

  if (inTesting.length > 0) {
    lines.push(`\n🧪 *In Testing (${inTesting.length})*`);
    inTesting.forEach((t) => {
      const who = t.assigneeName ?? "Unassigned";
      lines.push(`  • #${t.issueNumber}: ${t.title} — ${who}`);
    });
  }

  if (blocked.length > 0) {
    lines.push(`\n🚫 *Blocked (${blocked.length}) — Needs Attention!*`);
    blocked.forEach((t) => lines.push(`  • #${t.issueNumber}: ${t.title}`));
  }

  if (backlog.length > 0) {
    lines.push(`\n📋 *Backlog: ${backlog.length} ticket${backlog.length !== 1 ? "s" : ""} waiting*`);
  }

  const total = inDev.length + inReview.length + inTesting.length;
  if (total === 0 && backlog.length === 0) {
    lines.push(`\n🎉 All clear — no active tickets! Great work team.`);
  }

  lines.push(`\n━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Type \`status\` for full pipeline details.`);

  return lines.join("\n");
}

export async function postStandup(): Promise<void> {
  const message = buildStandupMessage();
  await notifyChannel(STATUS_CHANNEL, message);
  console.log(`[standup] Posted daily standup`);
}

/**
 * Schedule standup every weekday at 9am (server timezone).
 * Uses setInterval — no cron library needed.
 */
export function scheduleStandup(): void {
  console.log(`[standup] Standup scheduled for 9am weekdays`);

  const tick = () => {
    const now  = new Date();
    const hour = now.getHours();
    const day  = now.getDay(); // 0=Sun, 6=Sat
    const min  = now.getMinutes();

    if (day >= 1 && day <= 5 && hour === 9 && min === 0) {
      postStandup().catch(console.error);
    }
  };

  // Check every minute
  setInterval(tick, 60 * 1000);
}

// ── SLA checker — runs every 30 minutes ──────────────────────────────────────

export function scheduleSLAChecker(): void {
  const { SLA_HOURS } = { SLA_HOURS: { backlog: 24, in_dev: 48, in_review: 24, in_testing: 24, done: 0, blocked: 4 } };

  const check = async () => {
    const tickets = getAllTickets();
    for (const ticket of tickets) {
      if (ticket.stage === "done" || ticket.stage === "blocked") continue;

      const slaHours = SLA_HOURS[ticket.stage];
      const ageHours = hoursAgo(ticket.stageChangedAt);

      if (ageHours > slaHours) {
        console.log(`[sla] Ticket #${ticket.issueNumber} breached SLA (${ageHours}h > ${slaHours}h)`);
        await notifyChannel(
          STATUS_CHANNEL,
          `⏰ *SLA Alert: #${ticket.issueNumber}* has been in *${ticket.stage.replace("_", " ")}* for *${ageHours}h*\n` +
          `_${ticket.title}_\n` +
          `${ticket.assigneeName ? `Assignee: ${ticket.assigneeName}` : "No assignee"}`
        );
      }
    }
  };

  setInterval(() => check().catch(console.error), 30 * 60 * 1000);
  console.log(`[sla] SLA checker scheduled (every 30min)`);
}

// ── Notion smart sync — runs every 6h, costs nothing if no changes ────────────

/**
 * Checks Notion for pages changed since last index.
 * - 0 changes → 1 cheap API call, nothing else
 * - N changes → embeds + pushes only those N pages to Pinecone
 */
export function scheduleNotionSync(): void {
  const INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 hours

  const run = async () => {
    try {
      const { smartSyncNotion } = await import("../agent/nodes/readNotion.js");
      const result = await smartSyncNotion();

      if (result.checked === 0) {
        console.log(`[notionSync] ✅ No Notion changes detected — Pinecone already up to date`);
      } else if (result.checked === -1) {
        console.log(`[notionSync] ✅ Full reindex complete (${result.updated} pages)`);
      } else {
        console.log(`[notionSync] ✅ Synced ${result.updated} changed page(s) to Pinecone`);
      }
    } catch (err) {
      console.warn(`[notionSync] ⚠ Sync failed:`, (err as Error).message);
    }
  };

  // Run once after 6h, then every 6h
  setInterval(() => run(), INTERVAL_MS);
  console.log(`[notionSync] Smart sync scheduled (every 6h — only syncs changed pages)`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hoursAgo(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60));
}

function isToday(date: Date): boolean {
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth()    === now.getMonth()    &&
    date.getDate()     === now.getDate()
  );
}
