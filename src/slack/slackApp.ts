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
import { setSlackApp } from "./notifier.js";
import { scheduleStandup, scheduleSLAChecker } from "./standup.js";
import { hasDevSession, answerDevQuestion, endDevSession } from "./devAssistant.js";
import { answerKnowledgeQuestion } from "./knowledgeBase.js";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

function startSchedulers(): void {
  scheduleStandup();
  scheduleSLAChecker();
}

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
    setSlackApp(boltApp);
    await boltApp.start();
    startSchedulers();
    console.log(`[slack] ✅ Bot started in Socket Mode (WebSocket)`);
  } else {
    // ── HTTP Mode ────────────────────────────────────────────────────────────
    const receiver = new ExpressReceiver({
      signingSecret: signingSecret || "dummy-secret",
      endpoints: "/api/slack/events",
    });

    boltApp = new App({ token: botToken, receiver });
    registerHandlers(boltApp);
    setSlackApp(boltApp);
    await boltApp.start();
    startSchedulers();
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
  app.event("app_mention", async ({ event, say, ack }) => {
    // Acknowledge immediately to avoid Slack's 3s timeout
    if (typeof ack === "function") await (ack as () => Promise<void>)();

    const userId  = event.user ?? "unknown";
    const channel = event.channel;
    const rawText = stripMention(event.text ?? "").trim();

    console.log(`[slack] @mention from ${userId}: "${rawText.slice(0, 80)}"`);

    // Show typing indicator while processing
    await say({ text: "_Thinking..._", thread_ts: event.ts });

    const session = getOrCreateSession(userId, channel);
    const reply   = await routeMessage(session, rawText, userId);

    await say({ text: slackFormat(reply), thread_ts: event.ts });
  });

  // Direct message
  app.message(async ({ message, say }) => {
    // Filter to only user messages (not bot messages)
    if (message.subtype !== undefined) return;

    const msg     = message as { user?: string; channel?: string; text?: string; ts?: string };
    const userId  = msg.user    ?? "unknown";
    const channel = msg.channel ?? "unknown";
    const rawText = (msg.text   ?? "").trim();

    if (!rawText) return;

    console.log(`[slack] DM from ${userId}: "${rawText.slice(0, 80)}"`);

    // Show typing indicator while processing
    await say({ text: "_Thinking..._" });

    const session = getOrCreateSession(userId, channel);
    const reply   = await routeMessage(session, rawText, userId);

    await say({ text: slackFormat(reply) });
  });
}

// ── Routing — SDLC workflow commands + ticket creation ────────────────────────

async function routeMessage(session: ConversationSession, text: string, userId: string): Promise<string> {
  const lower = text.toLowerCase().trim();

  // ── Global commands ────────────────────────────────────────────────────────
  if (lower === "cancel" || lower === "reset" || lower === "start over") {
    endSession(userId);
    endDevSession(userId);
    return "Session cancelled. Send me a new message to start fresh! 👋";
  }

  if (lower === "help") return helpText();

  // ── Dev assistant — intercept messages when developer is in coding mode ────
  // Allow "done <number>" to pass through so workflow engine handles it
  const isDoneCommand = /^done\s+#?\d+$/.test(lower);
  if (hasDevSession(userId) && !isDoneCommand) {
    return answerDevQuestion(userId, text);
  }

  // ── Pipeline status ────────────────────────────────────────────────────────
  if (lower === "status" || lower === "pipeline") {
    const { buildPipelineStatus } = await import("./pipeline.js");
    return buildPipelineStatus();
  }

  // ── Tickets list ───────────────────────────────────────────────────────────
  if (lower === "tickets" || lower === "list tickets" || lower === "show tickets" || lower === "my tickets") {
    const { getAllTickets, getTicketsByAssignee } = await import("./workflow/store.js");
    const tickets = lower === "my tickets"
      ? getTicketsByAssignee(userId)
      : getAllTickets().filter((t) => t.stage !== "done");

    if (tickets.length === 0) {
      return lower === "my tickets"
        ? "You have no active tickets assigned to you."
        : "No active tickets found. Describe a feature to create one!";
    }

    const STAGE_EMOJI: Record<string, string> = {
      backlog: "📋", in_dev: "👨‍💻", in_review: "🔍", in_testing: "🧪", done: "✅", blocked: "🚫",
    };

    const lines = [
      `📋 *All Active Tickets (${tickets.length})*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ];

    for (const t of tickets) {
      const emoji    = STAGE_EMOJI[t.stage] ?? "❓";
      const stage    = t.stage.replace("_", " ").toUpperCase();
      const assignee = t.assigneeName ? ` · 👤 ${t.assigneeName}` : " · 👤 Unassigned";
      const dev      = t.developerMode === "ai" ? " · 🤖 AI Dev" : "";
      const link     = t.githubUrl ? `<${t.githubUrl}|#${t.issueNumber}>` : `#${t.issueNumber}`;
      lines.push(`${emoji} ${link} *${t.title}*`);
      lines.push(`    └ ${stage}${assignee}${dev}`);
    }

    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`_Type \`ticket <number>\` for full details_`);
    return lines.join("\n");
  }

  // ── Ticket detail: "ticket 23" OR just "23" OR "#23" ─────────────────────
  const ticketDetailMatch = lower.match(/^(?:ticket\s+)?#?(\d+)$/);
  if (ticketDetailMatch) {
    const { buildTicketDetail } = await import("./pipeline.js");
    const { getTicket } = await import("./workflow/store.js");
    const num = parseInt(ticketDetailMatch[1]);
    // Only treat bare numbers as ticket lookups if the ticket exists
    if (getTicket(num)) {
      return buildTicketDetail(num);
    }
  }

  // ── Standup ────────────────────────────────────────────────────────────────
  if (lower === "standup") {
    const { buildStandupMessage } = await import("./standup.js");
    return buildStandupMessage();
  }

  // ── Reindex Notion ─────────────────────────────────────────────────────────
  if (lower === "reindex") {
    const { reindexNotion } = await import("../agent/nodes/readNotion.js");
    const { RAGStore }      = await import("../tools/ragStore.js");
    const store = new RAGStore();
    await reindexNotion(store);
    return `✅ Notion reindexed! ${store.size} pages ready to query.`;
  }

  // ── Knowledge Q&A — "ask <question>" or "? <question>" or natural questions ─
  const askMatch = text.match(/^(?:ask|what|which|who|where|how|why|when|\?)\s+(.+)/i);
  if (askMatch ?? lower.includes("cluster") ?? lower.includes("service") ?? lower.includes("market") ?? lower.includes("team") ?? lower.includes("flow") ?? lower.includes("architecture")) {
    const question = askMatch ? askMatch[1] : text;
    return answerKnowledgeQuestion(question);
  }

  // ── Workflow commands: require a ticket number ─────────────────────────────
  const workflowResult = await handleWorkflowCommand(lower, text, userId);
  if (workflowResult) return workflowResult;

  // ── Ticket creation conversation ───────────────────────────────────────────
  switch (session.phase) {
    case "clarifying":
      return handleClarifying(session, text, userId);
    case "awaiting_approval":
      return handleApproval(session, text, userId);
    case "done": {
      endSession(userId);
      const fresh = getOrCreateSession(userId, session.conversationId);
      return handleClarifying(fresh, text, userId);
    }
    default:
      return "Something went wrong. Type *reset* to start over.";
  }
}

// ── Workflow command router ────────────────────────────────────────────────────

async function handleWorkflowCommand(lower: string, text: string, userId: string): Promise<string | null> {
  const {
    createWorkflowTicket, handleNewTicket, handleAIDevelop, handleAssign,
    handleHumanDevelop, handleDevDone, handleAIReview, handleDeploy,
    handleAITest, handleAssignTester, handleClose,
  } = await import("./workflow/engine.js");
  const { getTicket } = await import("./workflow/store.js");

  // develop / ai develop <number>
  let m = lower.match(/^(?:ai\s+)?develop\s+#?(\d+)$/);
  if (m) {
    const ticket = getTicket(parseInt(m[1]));
    if (!ticket) return `❓ Ticket #${m[1]} not found. Create it first by describing a feature.`;
    return handleAIDevelop(ticket, userId);
  }

  // assign <name> [to ticket <number>] OR assign tester <name> [to <number>]
  m = lower.match(/^assign\s+tester\s+(.+?)(?:\s+(?:to\s+)?#?(\d+))?$/);
  if (m) {
    const num = m[2] ? parseInt(m[2]) : await findRecentTicket(userId);
    if (!num) return `Please specify a ticket number: \`assign tester <name> <number>\``;
    const ticket = getTicket(num);
    if (!ticket) return `❓ Ticket #${num} not found.`;
    return handleAssignTester(ticket, m[1].trim(), userId);
  }

  m = lower.match(/^assign\s+(.+?)(?:\s+(?:to\s+)?#?(\d+))?$/);
  if (m) {
    const num = m[2] ? parseInt(m[2]) : await findRecentTicket(userId);
    if (!num) return `Please specify a ticket number: \`assign <name> <number>\``;
    const ticket = getTicket(num);
    if (!ticket) return `❓ Ticket #${num} not found.`;
    return handleAssign(ticket, m[1].trim(), userId);
  }

  // i'll do it <number>
  m = lower.match(/^i'?ll?\s+do\s+it\s+#?(\d+)$/);
  if (m) {
    const ticket = getTicket(parseInt(m[1]));
    if (!ticket) return `❓ Ticket #${m[1]} not found.`;
    return handleHumanDevelop(ticket, userId);
  }

  // done <number>
  m = lower.match(/^done\s+#?(\d+)$/);
  if (m) {
    const ticket = getTicket(parseInt(m[1]));
    if (!ticket) return `❓ Ticket #${m[1]} not found.`;
    endDevSession(userId); // close dev assistant session
    return handleDevDone(ticket, userId);
  }

  // review <number>
  m = lower.match(/^review\s+#?(\d+)$/);
  if (m) {
    const ticket = getTicket(parseInt(m[1]));
    if (!ticket) return `❓ Ticket #${m[1]} not found.`;
    return handleAIReview(ticket, userId);
  }

  // deploy <number>
  m = lower.match(/^(?:skip\s+)?deploy\s+#?(\d+)$/);
  if (m) {
    const ticket = getTicket(parseInt(m[1]));
    if (!ticket) return `❓ Ticket #${m[1]} not found.`;
    return handleDeploy(ticket, userId);
  }

  // ai test <number>
  m = lower.match(/^ai\s+test\s+#?(\d+)$/);
  if (m) {
    const ticket = getTicket(parseInt(m[1]));
    if (!ticket) return `❓ Ticket #${m[1]} not found.`;
    return handleAITest(ticket, userId);
  }

  // test myself <number>
  m = lower.match(/^test\s+myself\s+#?(\d+)$/);
  if (m) {
    const ticket = getTicket(parseInt(m[1]));
    if (!ticket) return `❓ Ticket #${m[1]} not found.`;
    return `Got it! Test #${m[1]} yourself. When all tests pass, type \`close ${m[1]}\`.`;
  }

  // close <number>
  m = lower.match(/^close\s+#?(\d+)$/);
  if (m) {
    const ticket = getTicket(parseInt(m[1]));
    if (!ticket) return `❓ Ticket #${m[1]} not found.`;
    return handleClose(ticket, userId, true);
  }

  return null; // not a workflow command
}

/** Find the most recent non-done ticket for a user */
async function findRecentTicket(userId: string): Promise<number | null> {
  try {
    const { getTicketsByAssignee, getAllTickets } = await import("./workflow/store.js");
    const assigned = getTicketsByAssignee(userId);
    if (assigned.length > 0) return assigned[assigned.length - 1].issueNumber;
    const all = getAllTickets().filter((t) => t.createdBy === userId && t.stage !== "done");
    if (all.length > 0) return all[all.length - 1].issueNumber;
  } catch { /* ignore */ }
  return null;
}

// ── Phase: clarifying ─────────────────────────────────────────────────────────

async function handleClarifying(session: ConversationSession, userText: string, userId: string): Promise<string> {
  await addTurnAndMaybeSummarize(session, "user", userText);
  session.clarifyRound++;

  const context = buildContext(session);

  const userSignalsReady = /\b(generate|ready|that'?s? (all|it)|go ahead|create|yes|ok(ay)?|sure)\b/i.test(userText);

  if (session.clarifyRound >= 3 || userSignalsReady) {
    return generateAndPresent(session, userText, context, userId);
  }

  let response: { ready: boolean; question?: string };
  try {
    response = await clarifyOrGenerate(context, userText);
  } catch {
    response = { ready: true };
  }

  if (response.ready) {
    return generateAndPresent(session, userText, context, userId);
  }

  const question = response.question ?? "Could you give me a bit more detail?";
  await addTurnAndMaybeSummarize(session, "assistant", question);
  return question;
}

// ── Generation ────────────────────────────────────────────────────────────────

async function generateAndPresent(
  session: ConversationSession,
  lastMessage: string,
  context: string,
  userId: string
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

async function handleApproval(session: ConversationSession, userText: string, userId: string): Promise<string> {
  const lower = userText.toLowerCase().trim();

  if (!session.pendingTicket) {
    session.phase = "clarifying";
    return "Something went wrong. What would you like to build?";
  }

  if (["approve", "yes", "ok", "lgtm", "ship it", "✅"].includes(lower)) {
    return createIssueAndTrigger(session, userId);
  }

  if (["reject", "no", "cancel", "discard"].includes(lower)) {
    endSession(userId);
    return "Ticket discarded. Send me a new message to start fresh! 👋";
  }

  if (lower.startsWith("edit:") || lower.startsWith("edit ")) {
    const edits = userText.replace(/^edit:?\s*/i, "").trim();
    return applyEdits(session, edits);
  }

  // Treat as additional context — regenerate
  await addTurnAndMaybeSummarize(session, "user", userText);
  return generateAndPresent(session, userText, buildContext(session), userId);
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

async function createIssueAndTrigger(session: ConversationSession, userId: string): Promise<string> {
  const ticket = session.pendingTicket!;
  const owner  = process.env.GITHUB_OWNER;
  const repo   = process.env.GITHUB_REPO;
  const token  = process.env.GITHUB_TOKEN;

  if (!owner || !repo || !token) {
    endSession(userId);
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

  // Register in workflow store
  const { createWorkflowTicket, handleNewTicket } = await import("./workflow/engine.js");
  const wfTicket = createWorkflowTicket(issueNumber, ticket.title, userId, issueUrl);

  endSession(userId);

  const nextSteps = await handleNewTicket(wfTicket, session.conversationId);

  return (
    `✅ *Issue #${issueNumber} created!*\n` +
    `📋 <${issueUrl}|${ticket.title}>\n\n` +
    nextSteps
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
    `*AI Engineering Agent — SDLC Bot* 🤖\n\n` +
    `*Create a ticket:* Just describe what you need — I'll ask a couple questions and draft a GitHub issue.\n\n` +
    `*Workflow commands:*\n` +
    `• \`develop <#>\` — AI writes the code for this ticket\n` +
    `• \`assign <name> <#>\` — assign to a developer\n` +
    `• \`assign tester <name> <#>\` — assign to a tester\n` +
    `• \`review <#>\` — AI reviews the PR\n` +
    `• \`deploy <#>\` — deploy to staging\n` +
    `• \`ai test <#>\` — AI generates test cases\n` +
    `• \`test myself <#>\` — you'll test it\n` +
    `• \`done <#>\` — mark development complete\n` +
    `• \`close <#>\` — close the ticket\n\n` +
    `*Status commands:*\n` +
    `• \`status\` — full pipeline view\n` +
    `• \`standup\` — today's standup summary\n` +
    `• \`ticket <#>\` — detail view of a ticket\n\n` +
    `*Knowledge Base (ask anything from Notion):*\n` +
    `• \`ask which cluster handles India?\`\n` +
    `• \`what is the payment flow?\`\n` +
    `• \`which team owns Order Service?\`\n` +
    `• \`reindex\` — force fresh Notion index\n\n` +
    `*Dev Assistant (auto-active when coding):*\n` +
    `Just ask anything — _"How should I write the DAO method?"_\n` +
    `I'll answer based on your actual codebase + past PRs.\n\n` +
    `*Other:* \`reset\` · \`cancel\` · \`help\``
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
