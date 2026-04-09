/**
 * Dev Assistant — RAG-powered coding assistant for developers.
 *
 * Activated when a developer picks "i'll do it <number>".
 * Stays active until developer types "done <number>".
 *
 * Context injected per question (~400 tokens total):
 *   - Ticket details          (~50 tokens)
 *   - Relevant repo files     (~150 tokens — signatures + preview)
 *   - Past PRs / memory       (~80 tokens)
 *   - Notion docs             (~80 tokens)
 *   - Conversation history    (~60 tokens — rolling summary)
 *
 * Uses Claude Sonnet for coding quality, Haiku for follow-ups.
 */

import Anthropic from "@anthropic-ai/sdk";
import { RAGStore } from "../tools/ragStore.js";
import { embedText } from "../tools/embeddings.js";
import { indexRepoIfNeeded, searchRepo } from "./repoIndexer.js";
import * as path from "path";

const client = new Anthropic();

// ── Session state per developer ───────────────────────────────────────────────

interface DevSession {
  userId:        string;
  issueNumber:   number;
  issueTitle:    string;
  turns:         { role: "user" | "assistant"; content: string }[];
  summary:       string;
  createdAt:     Date;
  updatedAt:     Date;
}

const devSessions = new Map<string, DevSession>();

export function startDevSession(userId: string, issueNumber: number, issueTitle: string): void {
  devSessions.set(userId, {
    userId,
    issueNumber,
    issueTitle,
    turns:     [],
    summary:   "",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log(`[devAssistant] Started session for ${userId} on ticket #${issueNumber}`);

  // Kick off repo indexing in background (non-blocking)
  indexRepoIfNeeded().catch((e) => console.warn(`[devAssistant] Repo index failed:`, e));
}

export function endDevSession(userId: string): void {
  devSessions.delete(userId);
}

export function hasDevSession(userId: string): boolean {
  return devSessions.has(userId);
}

// ── Main Q&A handler ──────────────────────────────────────────────────────────

export async function answerDevQuestion(userId: string, question: string): Promise<string> {
  const session = devSessions.get(userId);
  if (!session) {
    return "No active dev session. Pick a ticket first.";
  }

  session.updatedAt = new Date();
  session.turns.push({ role: "user", content: question });

  // Roll up history if too long
  if (session.turns.length > 8) {
    session.summary = await summarizeTurns(session.summary, session.turns.splice(0, 4));
  }

  // Build RAG context
  const context = await buildRAGContext(question, session);

  // Build conversation history
  const historyText = session.summary
    ? `[Earlier context] ${session.summary}\n\n`
    : "";

  const recentTurns = session.turns
    .slice(-6)
    .map((t) => `${t.role === "user" ? "Developer" : "Assistant"}: ${t.content}`)
    .join("\n");

  const systemPrompt =
    `You are a senior software engineer pair-programming with a developer.
You have deep knowledge of their codebase — always reference actual files, classes, and patterns you see.
Be concise, practical, and give code examples that match their existing conventions.
Never suggest libraries or patterns not already in the codebase unless asked.

Current ticket: #${session.issueNumber} — ${session.issueTitle}`;

  const userContent = [
    context ? `${context}\n\n---` : "",
    historyText + recentTurns,
    `Developer: ${question}`,
  ].filter(Boolean).join("\n");

  console.log(`[devAssistant] Answering question for #${session.issueNumber} (~${Math.ceil(userContent.length / 4)} tokens)`);

  const msg = await client.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: 600,
    system:     systemPrompt,
    messages:   [{ role: "user", content: userContent }],
  });

  const block  = msg.content[0];
  const answer = block.type === "text" ? block.text : "Sorry, I couldn't generate a response.";

  session.turns.push({ role: "assistant", content: answer });
  devSessions.set(userId, session);

  return answer;
}

// ── RAG context builder ───────────────────────────────────────────────────────

async function buildRAGContext(question: string, session: DevSession): Promise<string> {
  if (!process.env.VOYAGE_API_KEY) return "";

  let queryVector: number[];
  try {
    queryVector = await embedText(`${question} ${session.issueTitle}`);
  } catch {
    return "";
  }

  const sections: string[] = [];

  // 1. Relevant repo files (most important — actual codebase)
  const repoFiles = await searchRepo(queryVector, 4);
  if (repoFiles.length > 0) {
    sections.push("## Your Codebase (relevant files)");
    for (const f of repoFiles) {
      const sigs = f.signatures.slice(0, 8).join("\n  ");
      sections.push(`### ${f.path}\n  ${sigs}\n  Preview: ${f.preview.slice(0, 150)}...`);
    }
  }

  // 2. Past PRs (memory store)
  const memoryStore = new RAGStore(
    process.env.MEMORY_VECTOR_STORE_PATH ?? path.resolve("data", "memory-vectors.json")
  );
  if (memoryStore.size > 0) {
    const memHits = memoryStore.search(queryVector, 2).filter((h) => h.score > 0.5);
    if (memHits.length > 0) {
      sections.push("## Past PRs (similar work)");
      memHits.forEach((h) => {
        const meta = h.metadata as { type?: string; number?: number; title?: string; filesChanged?: string[] };
        const files = (meta.filesChanged ?? []).slice(0, 3).join(", ");
        sections.push(`- PR #${meta.number}: ${meta.title}${files ? ` (${files})` : ""}`);
      });
    }
  }

  // 3. Notion docs
  const notionStore = new RAGStore(
    process.env.NOTION_VECTOR_STORE_PATH ?? path.resolve("data", "notion-vectors.json")
  );
  if (notionStore.size > 0) {
    const notionHits = notionStore.search(queryVector, 2).filter((h) => h.score > 0.5);
    if (notionHits.length > 0) {
      sections.push("## Architecture Docs");
      notionHits.forEach((h) => {
        const meta = h.metadata as { title?: string; excerpt?: string };
        const excerpt = (meta.excerpt ?? h.text).slice(0, 100);
        sections.push(`- ${meta.title ?? "Doc"}: ${excerpt}`);
      });
    }
  }

  return sections.join("\n");
}

// ── Rolling summary ───────────────────────────────────────────────────────────

async function summarizeTurns(
  existing: string,
  turns: { role: "user" | "assistant"; content: string }[]
): Promise<string> {
  const dialogue = turns
    .map((t) => `${t.role === "user" ? "Dev" : "Bot"}: ${t.content}`)
    .join("\n");

  const prior = existing ? `Prior: ${existing}\n\n` : "";

  const msg = await client.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: 80,
    messages:   [{
      role:    "user",
      content: `${prior}Summarize in ≤60 tokens — key technical decisions and code discussed:\n\n${dialogue}`,
    }],
  });

  const block = msg.content[0];
  return block.type === "text" ? block.text.trim() : existing;
}
