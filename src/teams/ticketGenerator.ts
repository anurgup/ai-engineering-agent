/**
 * Generate a structured GitHub issue (title + body) from a Teams conversation.
 *
 * Uses Claude Haiku for low cost + fast response.
 * Injects compressed RAG context to keep total tokens under 500.
 *
 * Token breakdown:
 *   System prompt:       ~80 tokens
 *   Rolling summary:     ~60 tokens
 *   Last user message:   ~20 tokens
 *   RAG context:        ~105 tokens  (Notion + memory, top-3 each)
 *   ─────────────────────────────────
 *   Total input:        ~265 tokens  ✓ (well under 500)
 */

import Anthropic from "@anthropic-ai/sdk";
import { formatRAGForPrompt, type TeamsRAGContext } from "./ragContext.js";
import type { PendingTicket } from "./conversation.js";

const client = new Anthropic();

export interface GenerateTicketOptions {
  conversationContext: string;   // rolling summary + recent turns
  lastMessage: string;           // user's most recent message
  ragContext: TeamsRAGContext;
  projectHint?: string;          // e.g. "Java Spring Boot"
}

/**
 * Ask Claude Haiku to draft a GitHub issue from the conversation.
 * Returns a structured ticket or throws on failure.
 */
export async function generateTicket(opts: GenerateTicketOptions): Promise<PendingTicket> {
  const ragSection = formatRAGForPrompt(opts.ragContext);

  const systemPrompt = `You are a technical assistant that converts a user's feature/bug request into a concise GitHub issue.

Output ONLY valid JSON with these fields:
{
  "title": "Short imperative title (max 60 chars)",
  "body": "## Summary\\n<2-3 sentences>\\n\\n## Acceptance Criteria\\n- <bullet>\\n- <bullet>\\n\\n## Notes\\n<any technical hints>",
  "labels": ["feature" or "bug" or "enhancement"]
}

Rules:
- Title must be actionable (start with a verb: Add, Fix, Implement, Update…)
- Body must be markdown
- Do NOT duplicate work already done (see Past Work section if provided)
- Keep body under 200 words`;

  const userContent = [
    ragSection ? `${ragSection}\n\n---` : "",
    `## Conversation\n${opts.conversationContext}`,
    opts.lastMessage ? `User (final): ${opts.lastMessage}` : "",
    opts.projectHint ? `Project stack: ${opts.projectHint}` : "",
    "\nGenerate the GitHub issue JSON now.",
  ]
    .filter(Boolean)
    .join("\n");

  console.log(`[teams/ticketGen] Generating ticket with Haiku (~${estimateTokens(userContent)} input tokens)`);

  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
  });

  const block = msg.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type from Haiku");

  const raw = block.text.trim();

  // Strip markdown code fences if present
  const jsonStr = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();

  let parsed: { title?: string; body?: string; labels?: string[] };
  try {
    parsed = JSON.parse(jsonStr) as typeof parsed;
  } catch {
    throw new Error(`Failed to parse ticket JSON: ${raw.slice(0, 200)}`);
  }

  if (!parsed.title || !parsed.body) {
    throw new Error(`Incomplete ticket JSON — missing title or body`);
  }

  return {
    title:  parsed.title,
    body:   parsed.body,
    labels: parsed.labels ?? ["feature"],
  };
}

/**
 * Ask Haiku whether it has enough context to generate the ticket,
 * or if it needs one more clarification question.
 *
 * Returns { ready: true } or { ready: false, question: string }.
 * Very cheap: ~80 tokens total.
 */
export async function clarifyOrGenerate(
  conversationContext: string,
  lastMessage: string
): Promise<{ ready: boolean; question?: string }> {
  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 80,
    system:
      `You help gather requirements for a GitHub issue. Decide if you have enough context to write one, or ask ONE clarifying question.
Output JSON: {"ready": true} OR {"ready": false, "question": "<single question>"}
Be liberal — if you have a title + rough description, you have enough.`,
    messages: [
      {
        role: "user",
        content: `${conversationContext ? `Context so far:\n${conversationContext}\n\n` : ""}User said: ${lastMessage}\n\nDo you have enough to write the GitHub issue?`,
      },
    ],
  });

  const block = msg.content[0];
  if (block.type !== "text") return { ready: true };

  const raw = block.text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  try {
    const parsed = JSON.parse(raw) as { ready?: boolean; question?: string };
    return { ready: parsed.ready ?? true, question: parsed.question };
  } catch {
    // If parsing fails, assume ready to avoid infinite loops
    return { ready: true };
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
