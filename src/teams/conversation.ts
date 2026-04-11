/**
 * Teams conversation session manager.
 *
 * Tracks per-user state so the bot can carry context across multiple turns.
 * Rolling summary compresses history to ~60 tokens once it gets long.
 */

import Anthropic from "@anthropic-ai/sdk";

export type ConversationPhase =
  | "clarifying"   // collecting context, no RAG yet
  | "generating"   // Haiku is drafting the ticket
  | "awaiting_approval" // ticket shown, waiting for approve/reject/edit
  | "done";        // session closed

export interface TurnMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PendingTicket {
  title: string;
  body: string;
  labels?: string[];
}

export interface ConversationSession {
  userId: string;
  conversationId: string;
  phase: ConversationPhase;
  turns: TurnMessage[];          // raw recent messages (last 6 max)
  summary: string;               // rolling compressed summary
  pendingTicket?: PendingTicket;
  clarifyRound: number;          // how many clarification turns so far
  createdAt: Date;
  updatedAt: Date;
}

// In-memory session store — one entry per Teams user
const sessions = new Map<string, ConversationSession>();

// Session expires after 30 minutes of inactivity
const SESSION_TTL_MS = 30 * 60 * 1000;

// ── Public API ────────────────────────────────────────────────────────────────

export function getOrCreateSession(userId: string, conversationId: string): ConversationSession {
  purgeExpired();

  let session = sessions.get(userId);
  if (!session || session.phase === "done") {
    session = {
      userId,
      conversationId,
      phase: "clarifying",
      turns: [],
      summary: "",
      clarifyRound: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    sessions.set(userId, session);
    console.log(`[teams] New session for user ${userId}`);
  }
  session.updatedAt = new Date();
  return session;
}

export function getSession(userId: string): ConversationSession | undefined {
  return sessions.get(userId);
}

export function updateSession(session: ConversationSession): void {
  session.updatedAt = new Date();
  sessions.set(session.userId, session);
}

export function endSession(userId: string): void {
  const s = sessions.get(userId);
  if (s) {
    s.phase = "done";
    sessions.set(userId, s);
  }
}

/**
 * Append a turn and optionally roll up history into a summary.
 * Keeps only the last 6 raw turns — older ones are folded into `summary`.
 */
export async function addTurnAndMaybeSummarize(
  session: ConversationSession,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  session.turns.push({ role, content });

  // Once we have more than 6 turns, compress the oldest 4 into the summary
  if (session.turns.length > 6) {
    const toCompress = session.turns.splice(0, 4);
    session.summary = await compressTurns(session.summary, toCompress);
    console.log(`[teams] Rolled up ${toCompress.length} turns into summary`);
  }

  updateSession(session);
}

/**
 * Build a compact conversation context string for prompt injection.
 * Format: [Summary if any] + [last N turns]
 * Target: ~80 tokens total
 */
export function buildContext(session: ConversationSession): string {
  const parts: string[] = [];

  if (session.summary) {
    parts.push(`[Earlier context] ${session.summary}`);
  }

  for (const t of session.turns) {
    const label = t.role === "user" ? "User" : "Bot";
    parts.push(`${label}: ${t.content}`);
  }

  return parts.join("\n");
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function compressTurns(
  existingSummary: string,
  turns: TurnMessage[]
): Promise<string> {
  const client = new Anthropic();

  const dialogue = turns
    .map((t) => `${t.role === "user" ? "User" : "Bot"}: ${t.content}`)
    .join("\n");

  const prior = existingSummary ? `Prior summary: ${existingSummary}\n\n` : "";

  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 80,
    messages: [
      {
        role: "user",
        content:
          `${prior}Compress this conversation into ≤60 tokens, keeping only the key facts about what feature is needed:\n\n${dialogue}`,
      },
    ],
  });

  const block = msg.content[0];
  return block.type === "text" ? block.text.trim() : existingSummary;
}

function purgeExpired(): void {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.updatedAt.getTime() > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}
