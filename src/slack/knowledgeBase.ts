/**
 * Knowledge Base Q&A — answers any question from Notion pages.
 *
 * Covers:
 *   - Architecture: "which service calls Order API?"
 *   - Cluster/Market: "which cluster handles India?"
 *   - Team ownership: "who owns Payment Service?"
 *   - Compliance: "what rules apply to APAC?"
 *   - Flow: "trace the payment flow for India"
 *   - Impact: "if Cluster-B goes down what breaks?"
 *
 * Flow:
 *   1. Embed the question (Voyage AI)
 *   2. Search Notion vector store (RAG — FREE)
 *   3. If clear answer found → return directly (no LLM)
 *   4. If reasoning needed → LLM formats answer (1 call, ~200 tokens)
 *
 * Triggered by: "ask <question>" OR "?" prefix OR natural questions
 */

import Anthropic from "@anthropic-ai/sdk";
import { RAGStore } from "../tools/ragStore.js";
import { embedText } from "../tools/embeddings.js";
import * as path from "path";

const client = new Anthropic();

const NOTION_STORE_PATH = process.env.NOTION_VECTOR_STORE_PATH
  ?? path.resolve("data", "notion-vectors.json");

// ── Main handler ──────────────────────────────────────────────────────────────

export async function answerKnowledgeQuestion(question: string): Promise<string> {
  console.log(`[knowledge] Question: "${question.slice(0, 80)}"`);

  const store = new RAGStore(NOTION_STORE_PATH);

  if (store.size === 0) {
    return (
      `📚 Knowledge base is empty.\n\n` +
      `Add pages to Notion and I'll index them automatically.\n` +
      `Or type \`reindex\` to force a fresh index.`
    );
  }

  // ── Step 1: Embed question ────────────────────────────────────────────────
  if (!process.env.VOYAGE_API_KEY) {
    return await answerWithKeywordSearch(question, store);
  }

  let queryVector: number[];
  try {
    queryVector = await embedText(question);
  } catch (err) {
    console.warn(`[knowledge] Embedding failed:`, err);
    return await answerWithKeywordSearch(question, store);
  }

  // ── Step 2: RAG search ────────────────────────────────────────────────────
  const hits = store.search(queryVector, 5).filter((h) => h.score > 0.45);

  if (hits.length === 0) {
    return (
      `❓ I couldn't find anything relevant in your knowledge base.\n\n` +
      `Make sure the information is documented in Notion.\n` +
      `Type \`reindex\` if you recently added new pages.`
    );
  }

  console.log(`[knowledge] Found ${hits.length} relevant pages (top score: ${hits[0].score.toFixed(3)})`);

  // ── Step 3: Build context from hits ──────────────────────────────────────
  const context = hits.map((h) => {
    const meta    = h.metadata as { title?: string; excerpt?: string };
    const title   = meta.title   ?? "Untitled";
    const excerpt = meta.excerpt ?? h.text;
    return `### ${title}\n${excerpt.slice(0, 600)}`;
  }).join("\n\n");

  // ── Step 4: Simple question? Return directly without LLM ─────────────────
  const simpleAnswer = trySimpleAnswer(question, hits);
  if (simpleAnswer) {
    console.log(`[knowledge] Simple answer — no LLM needed`);
    return simpleAnswer;
  }

  // ── Step 5: Complex question → LLM formats answer (1 call) ───────────────
  const msg = await client.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: 400,
    system:
      `You answer questions about system architecture, clusters, markets, services, and teams.
Answer ONLY from the provided context. Be concise and direct.
If the answer isn't in the context, say "Not documented in Notion."
Format nicely for Slack (use bullet points for lists).`,
    messages: [{
      role:    "user",
      content: `Context from Notion:\n${context}\n\nQuestion: ${question}`,
    }],
  });

  const block  = msg.content[0];
  const answer = block.type === "text" ? block.text : "Could not generate answer.";

  // Add source references
  const sources = hits.slice(0, 3).map((h) => {
    const meta = h.metadata as { title?: string; url?: string };
    return meta.url
      ? `<${meta.url}|${meta.title ?? "Notion page"}>`
      : meta.title ?? "Notion page";
  }).join(", ");

  return `${answer}\n\n_📚 Sources: ${sources}_`;
}

// ── Simple answer — no LLM needed ────────────────────────────────────────────

function trySimpleAnswer(
  question: string,
  hits: Array<{ score: number; metadata: Record<string, unknown>; text: string }>
): string | null {
  const lower = question.toLowerCase();

  // "which cluster handles X?" → scan top hit for cluster info
  const clusterMatch = lower.match(/which cluster.{0,20}(handles?|for|serves?)\s+(.+?)(\?|$)/);
  if (clusterMatch && hits[0].score > 0.75) {
    const meta    = hits[0].metadata as { title?: string; excerpt?: string };
    const excerpt = meta.excerpt ?? hits[0].text;
    return `📍 Based on *${meta.title}*:\n\n${excerpt.slice(0, 300)}\n\n_📚 Source: ${meta.title}_`;
  }

  // Very high confidence single hit → return excerpt directly
  if (hits.length === 1 && hits[0].score > 0.85) {
    const meta    = hits[0].metadata as { title?: string; excerpt?: string; url?: string };
    const excerpt = (meta.excerpt ?? hits[0].text).slice(0, 400);
    const link    = meta.url ? `<${meta.url}|${meta.title}>` : meta.title ?? "Notion page";
    return `📍 *${meta.title}*\n\n${excerpt}\n\n_📚 Source: ${link}_`;
  }

  return null; // needs LLM
}

// ── Keyword fallback (no Voyage key) ─────────────────────────────────────────

async function answerWithKeywordSearch(question: string, store: RAGStore): Promise<string> {
  // Simple keyword match on stored text
  const words   = question.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const entries = (store as unknown as { entries: Array<{ id: string; text: string; metadata: Record<string, unknown> }> }).entries ?? [];

  const scored = entries
    .filter((e) => e.id !== "__meta__")
    .map((e) => ({
      ...e,
      score: words.filter((w) => e.text.toLowerCase().includes(w)).length,
    }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (scored.length === 0) {
    return `❓ Nothing found for "${question}". Add VOYAGE_API_KEY for better search.`;
  }

  const context = scored.map((e) => {
    const meta = e.metadata as { title?: string; excerpt?: string };
    return `### ${meta.title ?? "Untitled"}\n${(meta.excerpt ?? e.text).slice(0, 400)}`;
  }).join("\n\n");

  const msg = await client.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: 300,
    system:     `Answer from context only. Be concise.`,
    messages:   [{ role: "user", content: `Context:\n${context}\n\nQuestion: ${question}` }],
  });

  const block = msg.content[0];
  return block.type === "text" ? block.text : "Could not answer.";
}
