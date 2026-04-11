/**
 * Orchestrator Agent — the brain of the multi-agent system.
 *
 * Responsibilities:
 * 1. Owns the Slack Bolt App instance
 * 2. Receives all incoming Slack messages
 * 3. Routes messages to the correct agent via the event bus
 * 4. Handles all outbound Slack notifications (notify.user / notify.channel)
 * 5. Decides next steps in the workflow when events arrive
 * 6. Sends closure summaries when tickets are closed
 */

import { App, ExpressReceiver } from "@slack/bolt";
import type { Express } from "express";
import Anthropic from "@anthropic-ai/sdk";

import { eventBus } from "../../shared/eventBus.js";
import { setSlackApp, notifyUser, notifyChannel, sendTicketClosureSummary } from "../../slack/notifier.js";
import type { WorkflowTicket } from "../../slack/workflow/types.js";

const claudeClient = new Anthropic();

// ── Intent classification ──────────────────────────────────────────────────────

type MessageIntent =
  | "ticket"       // create / manage a GitHub issue
  | "knowledge"    // ask a technical/process question
  | "dev"          // dev assistant (write/explain code)
  | "workflow"     // workflow commands (assign, approve, done, etc.)
  | "standup"      // request a standup summary
  | "unknown";

async function classifyIntent(text: string): Promise<MessageIntent> {
  const lower = text.toLowerCase().trim();

  // Fast keyword routing first (cheap, no LLM call)
  if (/\b(standup|stand.?up|daily|summary|status update)\b/.test(lower)) return "standup";

  const workflowKeywords = [
    "assign", "approve", "reject", "done", "complete", "close", "block",
    "in.?review", "in.?testing", "deploy", "tickets", "ticket #", "issue #",
  ];
  if (workflowKeywords.some((kw) => new RegExp(kw).test(lower))) return "workflow";

  if (/\b(how|what|why|explain|when|where|who|which|does|is|are|can|should)\b/.test(lower) &&
      !/\b(create|build|add|implement|make|need|want)\b/.test(lower)) return "knowledge";

  if (/\b(write|generate|review|refactor|debug|explain this code|help me code)\b/.test(lower)) return "dev";

  // LLM for ambiguous cases
  try {
    const msg = await claudeClient.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 20,
      system: `Classify the user message into one of: ticket, knowledge, dev, workflow, standup, unknown.
Output ONLY the single word.
- ticket: requests to create a feature/bug/task for development
- knowledge: questions about the project, codebase, or processes
- dev: code writing, review, or explanation help
- workflow: managing existing tickets (assign, close, approve, etc.)
- standup: asking for team status or standup digest
- unknown: everything else`,
      messages: [{ role: "user", content: text }],
    });
    const intent = (msg.content[0] as { type: string; text: string }).text.trim().toLowerCase();
    if (["ticket", "knowledge", "dev", "workflow", "standup", "unknown"].includes(intent)) {
      return intent as MessageIntent;
    }
  } catch {
    // fall through to unknown
  }

  return "unknown";
}

// ── Orchestrator initialization ────────────────────────────────────────────────

export function initOrchestrator(app: App): void {
  // Give notifier the Bolt App reference
  setSlackApp(app);

  // ── Listen: outbound notifications ────────────────────────────────────────
  eventBus.on("notify.user", ({ userId, text }) => {
    notifyUser(userId, text).catch(console.error);
  });

  eventBus.on("notify.channel", ({ channel, text }) => {
    notifyChannel(channel, text).catch(console.error);
  });

  // ── Listen: ticket closed → send closure summary ──────────────────────────
  eventBus.on("ticket.closed", ({ ticket }) => {
    sendTicketClosureSummary(ticket).catch(console.error);
    notifyChannel(
      process.env.SLACK_DEFAULT_CHANNEL ?? "general",
      `✅ *Ticket #${ticket.issueNumber} closed:* ${ticket.title}`
    ).catch(console.error);
  });

  // ── Listen: ticket created → notify channel ───────────────────────────────
  eventBus.on("ticket.created", ({ issueNumber, title, channelId }) => {
    notifyChannel(channelId, `✅ *Issue #${issueNumber} created:* ${title}`).catch(console.error);
  });

  // ── Listen: PR created → notify channel ──────────────────────────────────
  eventBus.on("code.pr_created", ({ issueNumber, prNumber, prUrl }) => {
    notifyChannel(
      process.env.SLACK_DEFAULT_CHANNEL ?? "general",
      `🔀 *PR #${prNumber} opened* for issue #${issueNumber}: ${prUrl}`
    ).catch(console.error);
  });

  // ── Listen: stage changed → notify relevant people ───────────────────────
  eventBus.on("ticket.stage_changed", ({ issueNumber, fromStage, toStage, ticket }) => {
    const emoji: Record<string, string> = {
      backlog: "📋", in_dev: "👨‍💻", in_review: "🔍", in_testing: "🧪", done: "✅", blocked: "🚫",
    };
    const msg = `${emoji[toStage] ?? "•"} *Ticket #${issueNumber}* moved from \`${fromStage}\` → \`${toStage}\``;

    // DM assignee if they exist
    if (ticket.assigneeSlackId) {
      notifyUser(ticket.assigneeSlackId, msg).catch(console.error);
    }

    // Notify tester when moving to in_testing
    if (toStage === "in_testing" && ticket.testerSlackId) {
      notifyUser(
        ticket.testerSlackId,
        `🧪 *Ticket #${issueNumber} is ready for testing:* ${ticket.title}\n${ticket.prUrl ? `PR: ${ticket.prUrl}` : ""}`
      ).catch(console.error);
    }
  });

  console.log("[orchestrator] ✅ Initialized — listening on event bus");
}

// ── Route incoming Slack messages ─────────────────────────────────────────────

export async function routeMessage(
  text: string,
  userId: string,
  channelId: string
): Promise<string | null> {
  const intent = await classifyIntent(text);
  console.log(`[orchestrator] Intent for "${text.slice(0, 60)}": ${intent}`);

  switch (intent) {
    case "standup":
      eventBus.emit("standup.post_requested", { channelId });
      return null; // standup agent will post directly

    case "knowledge":
      // handled by caller invoking handleKnowledgeQuestion
      return "knowledge";

    default:
      // Return intent so the Slack router can invoke the right agent handler
      return intent;
  }
}

export { classifyIntent };
export type { MessageIntent };
