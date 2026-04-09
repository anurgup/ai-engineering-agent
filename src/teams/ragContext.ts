/**
 * Fetch compressed RAG context for the Teams bot.
 *
 * Returns top-3 Notion pages + top-3 memory entries relevant to the query,
 * each formatted as "title — one sentence" to keep token cost low (~105 tokens total).
 *
 * Reuses the same JSON vector stores as the main agent
 * (data/notion-vectors.json and data/memory-vectors.json).
 */

import { RAGStore } from "../tools/ragStore.js";
import { embedText } from "../tools/embeddings.js";
import * as path from "path";

export interface TeamsRAGContext {
  notionSnippets: string[];   // each: "Title — excerpt (1 sentence)"
  memorySnippets: string[];   // each: "PR #N: Title — what changed"
  tokenEstimate: number;
}

const NOTION_STORE_PATH = process.env.NOTION_VECTOR_STORE_PATH
  ?? path.resolve("data", "notion-vectors.json");

const MEMORY_STORE_PATH = process.env.MEMORY_VECTOR_STORE_PATH
  ?? path.resolve("data", "memory-vectors.json");

/**
 * Search both vector stores for context relevant to `query`.
 * Falls back to empty arrays if stores are empty or VOYAGE_API_KEY is missing.
 */
export async function fetchTeamsRAGContext(query: string): Promise<TeamsRAGContext> {
  if (!process.env.VOYAGE_API_KEY) {
    console.log(`[teams/rag] No VOYAGE_API_KEY — skipping RAG context`);
    return { notionSnippets: [], memorySnippets: [], tokenEstimate: 0 };
  }

  let queryVector: number[];
  try {
    queryVector = await embedText(query);
  } catch (err) {
    console.warn(`[teams/rag] Embedding failed:`, err);
    return { notionSnippets: [], memorySnippets: [], tokenEstimate: 0 };
  }

  const notionSnippets = searchNotionStore(queryVector);
  const memorySnippets = searchMemoryStore(queryVector);

  // Rough token estimate: ~4 chars per token
  const raw = [...notionSnippets, ...memorySnippets].join(" ");
  const tokenEstimate = Math.ceil(raw.length / 4);

  console.log(
    `[teams/rag] Found ${notionSnippets.length} Notion + ${memorySnippets.length} memory snippets (~${tokenEstimate} tokens)`
  );

  return { notionSnippets, memorySnippets, tokenEstimate };
}

/**
 * Format RAG context for prompt injection.
 * Compact format keeps total injection to ~105 tokens.
 */
export function formatRAGForPrompt(ctx: TeamsRAGContext): string {
  if (ctx.notionSnippets.length === 0 && ctx.memorySnippets.length === 0) {
    return "";
  }

  const lines: string[] = [];

  if (ctx.notionSnippets.length > 0) {
    lines.push("## Relevant Docs");
    ctx.notionSnippets.forEach((s) => lines.push(`- ${s}`));
  }

  if (ctx.memorySnippets.length > 0) {
    lines.push("## Past Work");
    ctx.memorySnippets.forEach((s) => lines.push(`- ${s}`));
  }

  return lines.join("\n");
}

// ── Internal ──────────────────────────────────────────────────────────────────

function searchNotionStore(queryVector: number[]): string[] {
  try {
    const store = new RAGStore(NOTION_STORE_PATH);
    if (store.size === 0) return [];

    return store
      .search(queryVector, 3)
      .filter((h) => h.score > 0.5)
      .map((h) => {
        const meta = h.metadata as { title?: string; excerpt?: string };
        const title   = meta.title   ?? "Untitled";
        // Take only the first sentence of the excerpt (~15 tokens)
        const excerpt = firstSentence(meta.excerpt ?? h.text, 80);
        return `${title} — ${excerpt}`;
      });
  } catch {
    return [];
  }
}

function searchMemoryStore(queryVector: number[]): string[] {
  try {
    const store = new RAGStore(MEMORY_STORE_PATH);
    if (store.size === 0) return [];

    return store
      .search(queryVector, 3)
      .filter((h) => h.score > 0.5)
      .map((h) => {
        const meta = h.metadata as {
          type?: string;
          number?: number;
          title?: string;
          filesChanged?: string[];
        };
        const type    = meta.type === "pr" ? "PR" : "Issue";
        const num     = meta.number ?? "?";
        const title   = meta.title ?? h.text;
        const files   = (meta.filesChanged ?? []).slice(0, 3).join(", ");
        const suffix  = files ? ` (files: ${files})` : "";
        return `${type} #${num}: ${title}${suffix}`;
      });
  } catch {
    return [];
  }
}

/** Return at most `maxChars` chars, truncated at a sentence boundary. */
function firstSentence(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const dot = cleaned.search(/[.!?]\s/);
  if (dot > 0 && dot < maxChars) {
    return cleaned.slice(0, dot + 1);
  }
  return cleaned.slice(0, maxChars) + (cleaned.length > maxChars ? "…" : "");
}
