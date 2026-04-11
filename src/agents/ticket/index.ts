/**
 * Ticket Agent
 *
 * Responsibilities:
 * - Handle Slack conversations for new feature/bug requests
 * - Draft GitHub issues using Claude Haiku
 * - Create GitHub issues after user approval
 * - Manage conversation sessions (clarify → approve → create)
 * - Emit ticket.created event for Orchestrator
 */

import { eventBus } from "../../shared/eventBus.js";
import {
  getOrCreateSession,
  endSession,
  addTurnAndMaybeSummarize,
  buildContext,
  type ConversationSession,
  type PendingTicket,
} from "../../teams/conversation.js";
import { clarifyOrGenerate, generateTicket } from "../../teams/ticketGenerator.js";
import { fetchTeamsRAGContext } from "../../teams/ragContext.js";
import { createWorkflowTicket, handleNewTicket } from "../../slack/workflow/engine.js";

function formatTicketPreview(ticket: PendingTicket): string {
  const labelStr = ticket.labels?.join(", ") ?? "feature";
  return (
    `📝 *Proposed GitHub Issue*\n\n` +
    `*Title:* ${ticket.title}\n` +
    `*Labels:* ${labelStr}\n\n` +
    `${ticket.body}\n\n` +
    `---\n` +
    `Reply *approve* to create & run agent, *edit: <changes>* to modify, or *reject* to cancel.`
  );
}

// ── Conversation phases ────────────────────────────────────────────────────────

async function handleClarifying(
  session: ConversationSession,
  userText: string
): Promise<string> {
  await addTurnAndMaybeSummarize(session, "user", userText);
  const context = buildContext(session);
  const { ready, question } = await clarifyOrGenerate(context, userText);

  if (!ready && question) {
    session.phase = "clarifying";
    await addTurnAndMaybeSummarize(session, "assistant", question);
    return question;
  }

  return generateAndPresent(session, userText, context);
}

async function generateAndPresent(
  session: ConversationSession,
  lastMessage: string,
  context: string
): Promise<string> {
  session.phase = "generating";

  const query  = `${lastMessage} ${context.replace(/\n/g, " ").slice(0, 100)}`.trim();
  const ragCtx = await fetchTeamsRAGContext(query);

  let ticket: PendingTicket;
  try {
    ticket = await generateTicket({ conversationContext: context, lastMessage, ragContext: ragCtx });
  } catch (err) {
    console.error("[ticket] generateTicket failed:", err);
    session.phase = "clarifying";
    return "Sorry, I had trouble drafting the ticket. Could you rephrase your request?";
  }

  session.pendingTicket = ticket;
  session.phase = "awaiting_approval";
  await addTurnAndMaybeSummarize(session, "assistant", "[Ticket draft shown]");
  return formatTicketPreview(ticket);
}

async function handleApproval(
  session: ConversationSession,
  userText: string,
  userId: string,
  channelId: string
): Promise<string> {
  const lower = userText.toLowerCase().trim();

  if (!session.pendingTicket) {
    session.phase = "clarifying";
    return "Something went wrong. What would you like to build?";
  }

  if (["approve", "yes", "ok", "lgtm", "ship it", "✅"].includes(lower)) {
    return createIssueAndTrigger(session, userId, channelId);
  }

  if (["reject", "no", "cancel", "discard"].includes(lower)) {
    endSession(userId);
    return "Ticket discarded. Send me a new message to start fresh! 👋";
  }

  if (lower.startsWith("edit:") || lower.startsWith("edit ")) {
    const edits = userText.replace(/^edit:?\s*/i, "").trim();
    session.phase = "clarifying";
    return handleClarifying(session, `Please update the ticket: ${edits}`);
  }

  return `Reply *approve* to create the issue, *reject* to discard, or *edit: <changes>* to modify.`;
}

async function createIssueAndTrigger(
  session: ConversationSession,
  userId: string,
  channelId: string
): Promise<string> {
  const ticket = session.pendingTicket!;
  const owner  = process.env.GITHUB_OWNER;
  const repo   = process.env.GITHUB_REPO;
  const token  = process.env.GITHUB_TOKEN;

  if (!owner || !repo || !token) {
    endSession(userId);
    return "⚠️ GitHub is not configured on the server.";
  }

  let issueNumber: number;
  let issueUrl: string;

  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
      method:  "POST",
      headers: {
        Authorization:  `token ${token}`,
        Accept:         "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: ticket.title, body: ticket.body, labels: ticket.labels ?? [] }),
    });

    if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${await resp.text()}`);

    const data = await resp.json() as { number: number; html_url: string };
    issueNumber = data.number;
    issueUrl    = data.html_url;
  } catch (err) {
    console.error("[ticket] createIssue failed:", err);
    return `❌ Failed to create GitHub issue: ${err instanceof Error ? err.message : String(err)}`;
  }

  const wfTicket = createWorkflowTicket(issueNumber, ticket.title, userId, issueUrl);
  endSession(userId);

  const nextSteps = await handleNewTicket(wfTicket, channelId);

  // Notify orchestrator
  eventBus.emit("ticket.created", {
    issueNumber,
    title:     ticket.title,
    createdBy: userId,
    channelId,
  });

  return `✅ *Issue #${issueNumber} created!*\n📋 <${issueUrl}|${ticket.title}>\n\n${nextSteps}`;
}

// ── Public API for Slack router ────────────────────────────────────────────────

export async function handleTicketMessage(
  text: string,
  userId: string,
  channelId: string
): Promise<string> {
  const session = getOrCreateSession(userId, channelId);

  switch (session.phase) {
    case "clarifying":
      return handleClarifying(session, text);
    case "awaiting_approval":
      return handleApproval(session, text, userId, channelId);
    case "done": {
      endSession(userId);
      const fresh = getOrCreateSession(userId, channelId);
      return handleClarifying(fresh, text);
    }
    default:
      session.phase = "clarifying";
      return handleClarifying(session, text);
  }
}

export function initTicketAgent(): void {
  console.log("[ticket] ✅ Ticket Agent initialized");
}
