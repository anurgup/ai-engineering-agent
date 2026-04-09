/**
 * Teams Outgoing Webhook handler.
 *
 * Flow:
 *   1. User @mentions the webhook in Teams → POST arrives here
 *   2. Phase: clarifying — Haiku asks up to 2 follow-up questions
 *   3. Phase: awaiting_approval — bot presents the drafted ticket, user says approve/reject/edit
 *   4. Phase: done — bot creates GitHub issue + triggers AI agent
 *
 * Token budget per turn:
 *   Clarifying: ~130 tokens   (summary + last message + system)
 *   Generation: ~265 tokens   (+ RAG context, once)
 *   Total per session: ~530 tokens across all turns  ✓
 *
 * No Azure Bot Framework needed — pure Express + Teams Outgoing Webhook.
 */

import * as crypto from "crypto";
import type { Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";

import {
  getOrCreateSession,
  endSession,
  addTurnAndMaybeSummarize,
  buildContext,
  type ConversationSession,
  type PendingTicket,
} from "./conversation.js";

import { clarifyOrGenerate, generateTicket } from "./ticketGenerator.js";
import { fetchTeamsRAGContext } from "./ragContext.js";

const client = new Anthropic();

// Teams Outgoing Webhook token (base64-encoded, set in Teams admin + env var)
const TEAMS_TOKEN = process.env.TEAMS_WEBHOOK_TOKEN ?? "";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TeamsActivity {
  type?: string;
  text?: string;
  from?: { id?: string; name?: string };
  conversation?: { id?: string };
  replyToId?: string;
}

// ── Signature validation ──────────────────────────────────────────────────────

/**
 * Teams Outgoing Webhooks use HMAC-SHA256 with the token as key.
 * Authorization header: "HMAC <base64digest>"
 */
export function validateTeamsSignature(rawBody: Buffer, authHeader: string | undefined): boolean {
  if (!TEAMS_TOKEN) return true; // skip in development

  if (!authHeader || !authHeader.startsWith("HMAC ")) return false;

  const providedDigest = authHeader.slice(5); // strip "HMAC "

  // Teams uses the raw UTF-8 body bytes and the token decoded from base64
  const keyBytes = Buffer.from(TEAMS_TOKEN, "base64");
  const hmac     = crypto.createHmac("sha256", keyBytes);
  hmac.update(rawBody);
  const expected = hmac.digest("base64");

  try {
    return crypto.timingSafeEqual(Buffer.from(providedDigest), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleTeamsMessage(req: Request & { rawBody?: Buffer }, res: Response): Promise<void> {
  // ── 1. Validate Teams signature
  if (!validateTeamsSignature(req.rawBody ?? Buffer.from(JSON.stringify(req.body)), req.headers["authorization"] as string | undefined)) {
    console.warn(`[teams] Invalid HMAC signature`);
    res.status(401).json({ type: "message", text: "Unauthorized" });
    return;
  }

  const activity = req.body as TeamsActivity;

  if (activity.type !== "message" || !activity.text) {
    res.json({ type: "message", text: "" });
    return;
  }

  const userId         = activity.from?.id ?? "unknown";
  const conversationId = activity.conversation?.id ?? "unknown";
  const rawText        = stripMention(activity.text).trim();

  console.log(`[teams] Message from ${userId}: "${rawText.slice(0, 80)}"`);

  const session = getOrCreateSession(userId, conversationId);
  const reply   = await routeMessage(session, rawText);

  res.json({ type: "message", text: reply });
}

// ── Routing ───────────────────────────────────────────────────────────────────

async function routeMessage(session: ConversationSession, text: string): Promise<string> {
  const lower = text.toLowerCase().trim();

  // ── Commands available at any time ───────────────────────────────────────
  if (lower === "cancel" || lower === "reset" || lower === "start over") {
    endSession(session.userId);
    return "Session cancelled. Send me a new message to start fresh! 👋";
  }

  if (lower === "help") {
    return helpText();
  }

  // ── Route by current phase ────────────────────────────────────────────────
  switch (session.phase) {
    case "clarifying":
      return handleClarifying(session, text);

    case "awaiting_approval":
      return handleApproval(session, text);

    case "done":
      // Start a fresh session
      endSession(session.userId);
      const fresh = getOrCreateSession(session.userId, session.conversationId);
      return handleClarifying(fresh, text);

    default:
      return "Something went wrong. Type **reset** to start over.";
  }
}

// ── Phase: clarifying ─────────────────────────────────────────────────────────

async function handleClarifying(session: ConversationSession, userText: string): Promise<string> {
  await addTurnAndMaybeSummarize(session, "user", userText);
  session.clarifyRound++;

  const context = buildContext(session);

  // After 3 rounds OR user signals they're done → switch to generation
  const userSignalsReady = /\b(generate|ready|that'?s? (all|it)|go ahead|create|yes|ok(ay)?|sure)\b/i.test(userText);

  if (session.clarifyRound >= 3 || userSignalsReady) {
    return generateAndPresent(session, userText, context);
  }

  // Ask Haiku if we have enough info or need one more question
  let response: { ready: boolean; question?: string };
  try {
    response = await clarifyOrGenerate(context, userText);
  } catch (err) {
    console.error(`[teams] clarifyOrGenerate failed:`, err);
    response = { ready: true };
  }

  if (response.ready) {
    return generateAndPresent(session, userText, context);
  }

  // Ask the clarifying question
  const question = response.question ?? "Could you give me a bit more detail?";
  await addTurnAndMaybeSummarize(session, "assistant", question);
  return question;
}

// ── Generation + presentation ─────────────────────────────────────────────────

async function generateAndPresent(
  session: ConversationSession,
  lastMessage: string,
  context: string
): Promise<string> {
  session.phase = "generating";

  // Fetch compressed RAG context (runs once, at generation time)
  const ragCtx = await fetchTeamsRAGContext(
    buildSearchQuery(context, lastMessage)
  );

  let ticket: PendingTicket;
  try {
    ticket = await generateTicket({
      conversationContext: context,
      lastMessage,
      ragContext: ragCtx,
    });
  } catch (err) {
    console.error(`[teams] generateTicket failed:`, err);
    session.phase = "clarifying";
    return "Sorry, I had trouble generating the ticket. Could you rephrase your request?";
  }

  session.pendingTicket = ticket;
  session.phase         = "awaiting_approval";

  await addTurnAndMaybeSummarize(session, "assistant", `[Ticket draft shown to user]`);

  return formatTicketPreview(ticket);
}

// ── Phase: awaiting_approval ──────────────────────────────────────────────────

async function handleApproval(session: ConversationSession, userText: string): Promise<string> {
  const lower = userText.toLowerCase().trim();

  if (!session.pendingTicket) {
    session.phase = "clarifying";
    return "Something went wrong. Let's start over — what would you like to build?";
  }

  // ── Approve ──────────────────────────────────────────────────────────────
  if (lower === "approve" || lower === "yes" || lower === "ok" || lower === "lgtm") {
    return createIssueAndTrigger(session);
  }

  // ── Reject ───────────────────────────────────────────────────────────────
  if (lower === "reject" || lower === "no" || lower === "cancel") {
    endSession(session.userId);
    return "Ticket discarded. Send me a new message to start fresh! 👋";
  }

  // ── Edit: <changes> ──────────────────────────────────────────────────────
  if (lower.startsWith("edit:") || lower.startsWith("edit ")) {
    const edits = userText.replace(/^edit:?\s*/i, "").trim();
    return applyEdits(session, edits);
  }

  // ── Unrecognised — treat as additional context ────────────────────────────
  await addTurnAndMaybeSummarize(session, "user", userText);
  const context = buildContext(session);
  return generateAndPresent(session, userText, context);
}

// ── Apply user edits to the pending ticket ────────────────────────────────────

async function applyEdits(session: ConversationSession, edits: string): Promise<string> {
  if (!session.pendingTicket) return "No pending ticket to edit.";

  const msg = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 400,
    system:
      `You update a GitHub issue based on user feedback. Output only valid JSON: {"title": "...", "body": "...", "labels": [...]}`,
    messages: [
      {
        role: "user",
        content: `Current ticket:\n${JSON.stringify(session.pendingTicket, null, 2)}\n\nApply these edits: ${edits}`,
      },
    ],
  });

  const block = msg.content[0];
  if (block.type !== "text") return "Failed to apply edits.";

  const raw = block.text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  try {
    const updated = JSON.parse(raw) as PendingTicket;
    session.pendingTicket = updated;
    return `Updated! Here's the revised ticket:\n\n${formatTicketPreview(updated)}`;
  } catch {
    return "Failed to parse updated ticket. Please try rephrasing your edits.";
  }
}

// ── Create GitHub issue + trigger agent ───────────────────────────────────────

async function createIssueAndTrigger(session: ConversationSession): Promise<string> {
  const ticket = session.pendingTicket!;

  const owner  = process.env.GITHUB_OWNER;
  const repo   = process.env.GITHUB_REPO;
  const token  = process.env.GITHUB_TOKEN;

  if (!owner || !repo || !token) {
    endSession(session.userId);
    return "⚠️ GitHub is not configured on the server. Please contact the admin.";
  }

  // Create the issue via GitHub API
  let issueNumber: number;
  let issueUrl: string;

  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
      method:  "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept:        "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title:  ticket.title,
        body:   ticket.body,
        labels: ticket.labels ?? [],
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`GitHub API ${resp.status}: ${err}`);
    }

    const data = await resp.json() as { number: number; html_url: string };
    issueNumber = data.number;
    issueUrl    = data.html_url;
  } catch (err) {
    console.error(`[teams] Failed to create GitHub issue:`, err);
    return `❌ Failed to create GitHub issue: ${err instanceof Error ? err.message : String(err)}`;
  }

  console.log(`[teams] ✅ Created issue #${issueNumber}: ${ticket.title}`);

  // Trigger the AI agent in background (same as GitHub webhook)
  const { buildGraph } = await import("../agent/graph.js");
  const graph = buildGraph();
  graph.invoke({ ticketKey: String(issueNumber), autoApprove: true }).catch((e: unknown) => {
    console.error(`[teams] Agent failed for issue #${issueNumber}:`, e);
  });

  endSession(session.userId);

  return (
    `✅ **Issue #${issueNumber} created and agent triggered!**\n\n` +
    `📋 [${ticket.title}](${issueUrl})\n\n` +
    `The AI Engineering Agent is now working on it. You'll see a PR in a few minutes.`
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTicketPreview(ticket: PendingTicket): string {
  const labelStr = ticket.labels?.join(", ") ?? "feature";
  return (
    `📝 **Proposed GitHub Issue**\n\n` +
    `**Title:** ${ticket.title}\n` +
    `**Labels:** ${labelStr}\n\n` +
    `${ticket.body}\n\n` +
    `---\n` +
    `Reply **approve** to create & run agent, **edit: <changes>** to modify, or **reject** to cancel.`
  );
}

function helpText(): string {
  return (
    `**AI Engineering Agent — Teams Bot**\n\n` +
    `Tell me what feature or bug you need. I'll:\n` +
    `1. Ask up to 2 clarifying questions\n` +
    `2. Show you a proposed GitHub issue\n` +
    `3. Wait for your **approve** / **edit** / **reject**\n` +
    `4. Create the issue and trigger the AI agent\n\n` +
    `Commands: **reset** · **cancel** · **help**`
  );
}

/** Strip @mentions from Teams message text */
function stripMention(text: string): string {
  return text.replace(/<at>[^<]*<\/at>/gi, "").replace(/^[\s@\w]+\s+/, "").trim();
}

/** Build a short search query from conversation context for RAG */
function buildSearchQuery(context: string, lastMessage: string): string {
  // Use last message + up to 100 chars of context as the search query
  const ctxSnippet = context.replace(/\n/g, " ").slice(0, 100);
  return `${lastMessage} ${ctxSnippet}`.trim();
}
