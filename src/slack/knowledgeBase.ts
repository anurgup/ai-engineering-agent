/**
 * Knowledge Base Q&A — answers questions from Notion pages via Pinecone RAG.
 *
 * Confidence tiers — LLM is only called as a last resort:
 *
 *   ≥ 0.87  EXACT    → single top hit, return excerpt directly (no LLM)
 *   ≥ 0.72  HIGH     → multiple strong hits, format + merge directly (no LLM)
 *   ≥ 0.55  MEDIUM   → hits found but need synthesis → LLM (1 call)
 *   < 0.55  NONE     → nothing relevant found
 *
 * This means the vast majority of factual questions (cluster, market, service,
 * team ownership, architecture) are answered purely from Pinecone — zero LLM cost.
 */

import Anthropic from "@anthropic-ai/sdk";
import { RAGStore } from "../tools/ragStore.js";
import { embedText } from "../tools/embeddings.js";
import * as path from "path";

const client = new Anthropic();

const NOTION_STORE_PATH = process.env.NOTION_VECTOR_STORE_PATH
  ?? path.resolve("data", "notion-vectors.json");

// ── Confidence thresholds ─────────────────────────────────────────────────────

const SCORE_EXACT  = 0.87;   // return top hit verbatim — no LLM
const SCORE_HIGH   = 0.72;   // merge top hits and return — no LLM
const SCORE_MEDIUM = 0.55;   // hits found but need LLM to synthesise
// below SCORE_MEDIUM → "not found"

// ── Main handler ──────────────────────────────────────────────────────────────

export async function answerKnowledgeQuestion(question: string): Promise<string> {
  console.log(`[knowledge] Question: "${question.slice(0, 80)}"`);

  // ── Step 1: Embed question ────────────────────────────────────────────────
  if (!process.env.VOYAGE_API_KEY) {
    return `⚠️ VOYAGE_API_KEY not set — cannot search knowledge base.`;
  }

  let queryVector: number[];
  try {
    queryVector = await embedText(question);
  } catch (err) {
    console.warn(`[knowledge] Embedding failed:`, err);
    return `❌ Could not embed question: ${(err as Error).message}`;
  }

  // ── Step 2: Search Pinecone directly — don't rely on local size ──────────
  // local store.size resets on every Railway restart even if Pinecone has data
  const store   = new RAGStore(NOTION_STORE_PATH);
  const allHits = await store.search(queryVector, 5);
  const hits    = allHits.filter((h) => h.score >= SCORE_MEDIUM);

  if (allHits.length === 0) {
    return (
      `📚 Knowledge base is empty.\n\n` +
      `Add pages to Notion and type \`reindex\` to index them.`
    );
  }

  if (hits.length === 0) {
    console.log(`[knowledge] No hits above threshold (best: ${allHits[0]?.score.toFixed(3) ?? "n/a"})`);
    return (
      `❓ Nothing relevant found in your knowledge base.\n\n` +
      `Make sure the information is documented in Notion.\n` +
      `Type \`reindex\` if you recently added new pages.`
    );
  }

  const topScore = hits[0].score;
  console.log(`[knowledge] ${hits.length} hit(s) — top score: ${topScore.toFixed(3)}`);

  // ── Tier 1: EXACT match — return top hit directly, no LLM ────────────────
  if (topScore >= SCORE_EXACT) {
    console.log(`[knowledge] ✅ EXACT confidence — answering from Pinecone directly (no LLM)`);
    return buildDirectAnswer(hits.slice(0, 1), question, "exact");
  }

  // ── Tier 2: HIGH confidence — merge top hits, return directly, no LLM ────
  if (topScore >= SCORE_HIGH) {
    console.log(`[knowledge] ✅ HIGH confidence — answering from Pinecone directly (no LLM)`);
    const strongHits = hits.filter((h) => h.score >= SCORE_HIGH);
    return buildDirectAnswer(strongHits, question, "high");
  }

  // ── Tier 3: MEDIUM confidence — LLM synthesises from context ─────────────
  console.log(`[knowledge] ⚡ MEDIUM confidence — calling LLM to synthesise answer`);
  return await answerWithLLM(question, hits);
}

// ── Direct answer builder (no LLM) ───────────────────────────────────────────

function buildDirectAnswer(
  hits:  Array<{ score: number; metadata: Record<string, unknown>; text: string }>,
  question: string,
  tier:  "exact" | "high"
): string {
  const lines: string[] = [];

  if (hits.length === 1) {
    const meta    = hits[0].metadata as { title?: string; excerpt?: string; url?: string };
    const title   = meta.title   ?? "Notion page";
    const excerpt = (meta.excerpt ?? hits[0].text).trim();
    const link    = meta.url ? `<${meta.url}|${title}>` : title;

    lines.push(`📍 *${title}*`);
    lines.push(``);
    lines.push(formatExcerpt(excerpt, question));
    lines.push(``);
    lines.push(`_📚 Source: ${link}_`);
  } else {
    // Multiple strong hits — show each with its title
    lines.push(`📍 *Found in ${hits.length} pages:*`);
    lines.push(``);

    for (const hit of hits) {
      const meta    = hit.metadata as { title?: string; excerpt?: string; url?: string };
      const title   = meta.title   ?? "Notion page";
      const excerpt = (meta.excerpt ?? hit.text).trim();
      const link    = meta.url ? `<${meta.url}|${title}>` : title;
      const conf    = `${Math.round(hit.score * 100)}%`;

      lines.push(`*${link}* _(${conf} match)_`);
      lines.push(formatExcerpt(excerpt, question, 250));
      lines.push(``);
    }

    const sourceLinks = hits.map((h) => {
      const meta = h.metadata as { title?: string; url?: string };
      return meta.url ? `<${meta.url}|${meta.title ?? "page"}>` : (meta.title ?? "page");
    }).join(", ");
    lines.push(`_📚 Sources: ${sourceLinks}_`);
  }

  return lines.join("\n");
}

/**
 * Extract the most relevant sentences from an excerpt for the given question.
 * Prefers sentences that share keywords with the question.
 */
function formatExcerpt(excerpt: string, question: string, maxChars = 400): string {
  const cleaned    = excerpt.replace(/\s+/g, " ").trim();
  const keywords   = question.toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

  // Split into sentences
  const sentences = cleaned.match(/[^.!?\n]+[.!?\n]?/g) ?? [cleaned];

  // Score each sentence by keyword overlap
  const scored = sentences.map((s) => ({
    text:  s.trim(),
    score: keywords.filter((k) => s.toLowerCase().includes(k)).length,
  }));

  // Sort by score descending, take top sentences up to maxChars
  const top = scored
    .filter((s) => s.text.length > 10)
    .sort((a, b) => b.score - a.score);

  let result = "";
  for (const s of top) {
    if ((result + s.text).length > maxChars) break;
    result += (result ? " " : "") + s.text;
  }

  // Fallback: just truncate the excerpt
  if (!result) result = cleaned.slice(0, maxChars) + (cleaned.length > maxChars ? "…" : "");

  return result;
}

const STOP_WORDS = new Set([
  "what", "which", "where", "when", "does", "will", "that", "this",
  "with", "from", "have", "been", "there", "their", "about", "would",
]);

// ── LLM synthesis (only for medium-confidence hits) ──────────────────────────

async function answerWithLLM(
  question: string,
  hits:     Array<{ score: number; metadata: Record<string, unknown>; text: string }>
): Promise<string> {
  const context = hits.map((h) => {
    const meta    = h.metadata as { title?: string; excerpt?: string };
    const title   = meta.title   ?? "Untitled";
    const excerpt = (meta.excerpt ?? h.text).slice(0, 500);
    return `### ${title}\n${excerpt}`;
  }).join("\n\n");

  const msg = await client.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system:
      `You are a knowledgeable assistant answering questions about this organisation's domain, processes, architecture, and business rules.
Answer ONLY from the provided Notion context. Be concise and direct.
If the answer is not clearly in the context, say "Not documented in Notion — try \`reindex\` if you recently added pages."
Format for Slack: use bullet points for lists, *bold* for key terms. No long paragraphs.`,
    messages: [{
      role:    "user",
      content: `Context:\n${context}\n\nQuestion: ${question}`,
    }],
  });

  const block  = msg.content[0];
  const answer = block.type === "text" ? block.text : "Could not generate answer.";

  const sources = hits.slice(0, 3).map((h) => {
    const meta = h.metadata as { title?: string; url?: string };
    return meta.url
      ? `<${meta.url}|${meta.title ?? "Notion page"}>`
      : (meta.title ?? "Notion page");
  }).join(", ");

  return `${answer}\n\n_📚 Sources: ${sources}_`;
}
