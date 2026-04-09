/**
 * Slack bot using Bolt for Node.js.
 *
 * Supports two modes:
 *   - Socket Mode (SLACK_APP_TOKEN set): WebSocket, no public URL needed ← easiest
 *   - HTTP Mode  (no SLACK_APP_TOKEN):  Express receiver, needs public URL
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN      xoxb-...   (Bot User OAuth Token)
 *   SLACK_SIGNING_SECRET            (Basic Information → App Credentials)
 *   SLACK_APP_TOKEN      xapp-...   (Socket Mode token — enables Socket Mode)
 */

import { App, ExpressReceiver } from "@slack/bolt";
import type { Express } from "express";

import {
  getOrCreateSession,
  endSession,
  addTurnAndMaybeSummarize,
  buildContext,
  type ConversationSession,
  type PendingTicket,
} from "../teams/conversation.js";

import { clarifyOrGenerate, generateTicket } from "../teams/ticketGenerator.js";
import { fetchTeamsRAGContext } from "../teams/ragContext.js";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// ── Bolt app + Express receiver ───────────────────────────────────────────────

let boltApp: App;

/**
 * Start the Slack bot.
 * - If SLACK_APP_TOKEN is set → Socket Mode (WebSocket, no public URL needed)
 * - Otherwise → HTTP mode (mounts on Express)
 */
export async function startSlackBot(): Promise<void> {
  const signingSecret = process.env.SLACK_SIGNING_SECRET ?? "";
  const botToken      = process.env.SLACK_BOT_TOKEN      ?? "";
  const appToken      = process.env.SLACK_APP_TOKEN      ?? "";

  if (!botToken) {
    console.warn(`[slack] ⚠ SLACK_BOT_TOKEN not set — Slack bot disabled`);
    return;
  }

  if (appToken) {
    // ── Socket Mode ──────────────────────────────────────────────────────────
    boltApp = new App({
      token:      botToken,
      appToken,
      socketMode: true,
    });

    registerHandlers(boltApp);
    await boltApp.start();
    console.log(`[slack] ✅ Bot started in Socket Mode (WebSocket)`);
  } else {
    // ── HTTP Mode ────────────────────────────────────────────────────────────
    const receiver = new ExpressReceiver({
      signingSecret: signingSecret || "dummy-secret",
      endpoints: "/api/slack/events",
    });

    boltApp = new App({ token: botToken, receiver });
    registerHandlers(boltApp);
    await boltApp.start();
    console.log(`[slack] ✅ Bot started in HTTP mode at POST /api/slack/events`);
  }
}

/** Mount Slack HTTP receiver onto an existing Express app (HTTP mode only) */
export function mountSlackOnExpress(expressApp: Express): void {
  const signingSecret = process.env.SLACK_SIGNING_SECRET ?? "";
  const botToken      = process.env.SLACK_BOT_TOKEN      ?? "";

  if (!botToken) return;

  const receiver = new ExpressReceiver({
    signingSecret: signingSecret || "dummy-secret",
    endpoints: "/api/slack/events",
  });

  boltApp = new App({ token: botToken, receiver });
  registerHandlers(boltApp);
  expressApp.use(receiver.router);
  console.log(`[slack] Bot mounted at POST /api/slack/events`);
}

// ── Event handlers ────────────────────────────────────────────────────────────

function registerHandlers(app: App): void {
  // @mention in a channel
  app.event("app_mention", async ({ event, say }) => {
    const userId = event.user ?? "unknown";
    const channelId = event.channel;
    const rawText = stripMention(event.text ?? "").trim();

    console.log(`[slack] @mention from ${userId}: "${rawText.slice(0, 80)}"`);

    const session = getOrCreateSession(userId, channelId);
    const reply   = await routeMessage(session, rawText);

    await say({ text: slackFormat(reply), thread_ts: event.ts });
  });

  // Direct message
  app.message(async ({ message, say }) => {
    // Filter to only user messages (not bot messages)
    if (message.subtype !== undefined) return;

    // TypeScript: message.text exists on regular messages
    const msg     = message as { user?: string; channel?: string; text?: string; ts?: string };
    const userId  = msg.user    ?? "unknown";
    const channel = msg.channel ?? "unknown";
    const rawText = (msg.text   ?? "").trim();

    if (!rawText) return;

    console.log(`[slack] DM from ${userId}: "${rawText.slice(0, 80)}"`);

    const session = getOrCreateSession(userId, channel);
    const reply   = await routeMessage(session, rawText);

    await say({ text: slackFormat(reply), thread_ts: msg.ts });
  });
}

// ── Routing (same logic as Teams bot) ────────────────────────────────────────

async function routeMessage(session: ConversationSession, text: string): Promise<string> {
  const lower = text.toLowerCase().trim();

  if (lower === "cancel" || lower === "reset" || lower === "start over") {
    endSession(session.userId);
    return "Session cancelled. Send me a new message to start fresh! 👋";
  }

  if (lower === "help") return helpText();

  switch (session.phase) {
    case "clarifying":
      return handleClarifying(session, text);
    case "awaiting_approval":
      return handleApproval(session, text);
    case "done": {
      endSession(session.userId);
      const fresh = getOrCreateSession(session.userId, session.conversationId);
      return handleClarifying(fresh, text);
    }
    default:
      return "Something went wrong. Type *reset* to start over.";
  }
}

// ── Phase: clarifying ─────────────────────────────────────────────────────────

async function handleClarifying(session: ConversationSession, userText: string): Promise<string> {
  await addTurnAndMaybeSummarize(session, "user", userText);
  session.clarifyRound++;

  const context = buildContext(session);

  const userSignalsReady = /\b(generate|ready|that'?s? (all|it)|go ahead|create|yes|ok(ay)?|sure)\b/i.test(userText);

  if (session.clarifyRound >= 3 || userSignalsReady) {
    return generateAndPresent(session, userText, context);
  }

  let response: { ready: boolean; question?: string };
  try {
    response = await clarifyOrGenerate(context, userText);
  } catch {
    response = { ready: true };
  }

  if (response.ready) {
    return generateAndPresent(session, userText, context);
  }

  const question = response.question ?? "Could you give me a bit more detail?";
  await addTurnAndMaybeSummarize(session, "assistant", question);
  return question;
}

// ── Generation ────────────────────────────────────────────────────────────────

async function generateAndPresent(
  session: ConversationSession,
  lastMessage: string,
  context: string
): Promise<string> {
  session.phase = "generating";

  const query   = `${lastMessage} ${context.replace(/\n/g, " ").slice(0, 100)}`.trim();
  const ragCtx  = await fetchTeamsRAGContext(query);

  let ticket: PendingTicket;
  try {
    ticket = await generateTicket({ conversationContext: context, lastMessage, ragContext: ragCtx });
  } catch (err) {
    console.error(`[slack] generateTicket failed:`, err);
    session.phase = "clarifying";
    return "Sorry, I had trouble drafting the ticket. Could you rephrase your request?";
  }

  session.pendingTicket = ticket;
  session.phase         = "awaiting_approval";

  await addTurnAndMaybeSummarize(session, "assistant", "[Ticket draft shown]");
  return formatTicketPreview(ticket);
}

// ── Phase: awaiting_approval ──────────────────────────────────────────────────

async function handleApproval(session: ConversationSession, userText: string): Promise<string> {
  const lower = userText.toLowerCase().trim();

  if (!session.pendingTicket) {
    session.phase = "clarifying";
    return "Something went wrong. What would you like to build?";
  }

  if (["approve", "yes", "ok", "lgtm", "ship it", "✅"].includes(lower)) {
    return createIssueAndTrigger(session);
  }

  if (["reject", "no", "cancel", "discard"].includes(lower)) {
    endSession(session.userId);
    return "Ticket discarded. Send me a new message to start fresh! 👋";
  }

  if (lower.startsWith("edit:") || lower.startsWith("edit ")) {
    const edits = userText.replace(/^edit:?\s*/i, "").trim();
    return applyEdits(session, edits);
  }

  // Treat as additional context — regenerate
  await addTurnAndMaybeSummarize(session, "user", userText);
  return generateAndPresent(session, userText, buildContext(session));
}

// ── Apply edits ───────────────────────────────────────────────────────────────

async function applyEdits(session: ConversationSession, edits: string): Promise<string> {
  if (!session.pendingTicket) return "No pending ticket to edit.";

  const msg = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 400,
    system: `Update a GitHub issue based on user feedback. Output only valid JSON: {"title":"...","body":"...","labels":[...]}`,
    messages: [{
      role: "user",
      content: `Current ticket:\n${JSON.stringify(session.pendingTicket, null, 2)}\n\nApply these edits: ${edits}`,
    }],
  });

  const block = msg.content[0];
  if (block.type !== "text") return "Failed to apply edits.";

  const raw = block.text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  try {
    const updated = JSON.parse(raw) as PendingTicket;
    session.pendingTicket = updated;
    return `Updated! Here's the revised ticket:\n\n${formatTicketPreview(updated)}`;
  } catch {
    return "Couldn't parse the update. Try rephrasing your edits.";
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
    console.error(`[slack] Failed to create GitHub issue:`, err);
    return `❌ Failed to create GitHub issue: ${err instanceof Error ? err.message : String(err)}`;
  }

  console.log(`[slack] ✅ Created issue #${issueNumber}: ${ticket.title}`);

  // Trigger the AI agent in background
  const { buildGraph } = await import("../agent/graph.js");
  buildGraph()
    .invoke({ ticketKey: String(issueNumber), autoApprove: true })
    .catch((e: unknown) => console.error(`[slack] Agent failed for #${issueNumber}:`, e));

  endSession(session.userId);

  return (
    `✅ *Issue #${issueNumber} created and agent triggered!*\n\n` +
    `📋 <${issueUrl}|${ticket.title}>\n\n` +
    `The AI Engineering Agent is now working on it. You'll see a PR in a few minutes. 🚀`
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function helpText(): string {
  return (
    `*AI Engineering Agent — Slack Bot*\n\n` +
    `Tell me what feature or bug you need. I'll:\n` +
    `1. Ask up to 2 clarifying questions\n` +
    `2. Show you a proposed GitHub issue\n` +
    `3. Wait for your *approve* / *edit* / *reject*\n` +
    `4. Create the issue and trigger the AI agent\n\n` +
    `Commands: *reset* · *cancel* · *help*`
  );
}

/** Strip Slack @mention tags: <@U123ABC> */
function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

/** Convert markdown-ish formatting to Slack mrkdwn */
function slackFormat(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "*$1*")   // **bold** → *bold*
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>"); // [text](url) → <url|text>
}
