/**
 * Pipeline status command.
 * Returns a full view of all active tickets by stage.
 */

import { getAllTickets, getTicketsByStage } from "./workflow/store.js";
import type { TicketStage } from "./workflow/types.js";

const STAGE_EMOJI: Record<TicketStage, string> = {
  backlog:    "📋",
  in_dev:     "👨‍💻",
  in_review:  "🔍",
  in_testing: "🧪",
  done:       "✅",
  blocked:    "🚫",
};

const STAGE_LABEL: Record<TicketStage, string> = {
  backlog:    "Backlog",
  in_dev:     "In Development",
  in_review:  "In Review",
  in_testing: "In Testing",
  done:       "Done",
  blocked:    "Blocked",
};

export function buildPipelineStatus(filter?: TicketStage): string {
  const tickets = filter ? getTicketsByStage(filter) : getAllTickets();

  if (tickets.length === 0) {
    return "📊 *Pipeline is empty* — no tickets yet.\n\nCreate one by describing a feature!";
  }

  const stages: TicketStage[] = ["blocked", "in_dev", "in_review", "in_testing", "backlog", "done"];
  const lines: string[] = ["📊 *Pipeline Status*", "━━━━━━━━━━━━━━━━━━━━━━━━"];

  for (const stage of stages) {
    const stageTickets = tickets.filter((t) => t.stage === stage);
    if (stageTickets.length === 0) continue;

    lines.push(`\n${STAGE_EMOJI[stage]} *${STAGE_LABEL[stage]} (${stageTickets.length})*`);

    for (const t of stageTickets) {
      const assignee = t.assigneeName ? ` · ${t.assigneeName}` : "";
      const mode     = t.developerMode === "ai" ? " 🤖" : t.developerMode === "human" ? " 👤" : "";
      const age      = hoursAgo(t.stageChangedAt);
      const ageStr   = age > 0 ? ` _(${age}h)_` : "";
      const link     = t.githubUrl ? ` <${t.githubUrl}|#${t.issueNumber}>` : ` #${t.issueNumber}`;
      lines.push(`  •${link}: ${t.title}${assignee}${mode}${ageStr}`);
    }
  }

  lines.push("\n━━━━━━━━━━━━━━━━━━━━━━━━");

  const active = tickets.filter((t) => t.stage !== "done").length;
  const done   = tickets.filter((t) => t.stage === "done").length;
  lines.push(`_${active} active · ${done} done_`);

  return lines.join("\n");
}

export async function buildTicketDetail(issueNumber: number): Promise<string> {
  const { getTicket } = await import("./workflow/store.js");
  const ticket = getTicket(issueNumber);

  if (!ticket) {
    return `❓ Ticket #${issueNumber} not found in workflow.`;
  }

  const lines = [
    `📋 *Ticket #${ticket.issueNumber}: ${ticket.title}*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `*Stage:* ${STAGE_EMOJI[ticket.stage]} ${STAGE_LABEL[ticket.stage]}`,
    `*Assignee:* ${ticket.assigneeName ?? "Unassigned"}`,
    `*Developer:* ${ticket.developerMode === "ai" ? "🤖 AI" : ticket.developerMode === "human" ? "👤 Human" : "Pending"}`,
    `*Test mode:* ${ticket.testMode === "ai" ? "🤖 AI" : ticket.testMode === "human" ? "👤 Human" : "Pending"}`,
    ticket.prUrl ? `*PR:* <${ticket.prUrl}|View PR>` : "",
    `*Created:* ${formatDate(ticket.createdAt)}`,
    `*In current stage for:* ${hoursAgo(ticket.stageChangedAt)}h`,
    ``,
    `*History:*`,
    ...ticket.history.map(
      (h) => `  • ${STAGE_EMOJI[h.stage]} ${STAGE_LABEL[h.stage]} — ${formatDate(h.at)}${h.note ? ` _(${h.note})_` : ""}`
    ),
  ].filter(Boolean);

  return lines.join("\n");
}

function hoursAgo(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60));
}

function formatDate(date: Date): string {
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
