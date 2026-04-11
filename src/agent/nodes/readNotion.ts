import { AgentState, NotionPage } from "../state.js";
import { NotionClient }           from "../../tools/notion.js";
import { RAGStore }               from "../../tools/ragStore.js";
import { embedText, embedBatch }  from "../../tools/embeddings.js";
import { getCommenter }           from "../../tools/issueCommenter.js";

const MIN_SCORE        = 0.50;  // minimum cosine similarity to include a page
const TOP_K            = 5;     // max pages to return
const MAX_AGE_HOURS    = 24;    // re-index Notion if index is older than this

// Shared store instance — persists across runs in the same process
let store: RAGStore | null = null;

function getStore(): RAGStore {
  if (!store) store = new RAGStore();
  return store;
}

// ── Main node ─────────────────────────────────────────────────────────────────

export async function readNotion(state: AgentState): Promise<Partial<AgentState>> {
  const ticket = state.ticket!;

  // If Voyage key is missing fall back to keyword search gracefully
  if (!process.env.VOYAGE_API_KEY) {
    console.log(`\n[readNotion] ⚠ VOYAGE_API_KEY not set — falling back to keyword search`);
    return keywordFallback(ticket.title, ticket.labels);
  }

  const ragStore = getStore();

  // ── Re-index if stale or empty ──────────────────────────────────────────────
  if (ragStore.isStale(MAX_AGE_HOURS) || ragStore.size === 0) {
    await reindexNotion(ragStore);
  } else {
    const last = ragStore.getLastIndexed();
    console.log(
      `\n[readNotion] Using cached RAG index — ${ragStore.size} pages ` +
      `(last indexed: ${last?.toLocaleString() ?? "unknown"})`
    );
  }

  // ── Semantic search ─────────────────────────────────────────────────────────
  const query = buildQuery(state);
  console.log(`[readNotion] Semantic search: "${query.slice(0, 100)}..."`);

  const queryVector = await embedText(query);
  const hits        = await ragStore.search(queryVector, TOP_K);
  const relevant    = hits.filter((h) => h.score >= MIN_SCORE);

  const pages: NotionPage[] = relevant.map((h) => h.metadata as unknown as NotionPage);

  console.log(`[readNotion] ✓ ${pages.length} relevant page(s) found (threshold: ${MIN_SCORE}):`);
  relevant.forEach((h, i) =>
    console.log(`  ${i + 1}. "${(h.metadata as unknown as NotionPage).title}"  score=${h.score.toFixed(3)}`)
  );

  if (pages.length === 0) {
    console.log(`[readNotion]   (no pages above threshold — agent will rely on repo context only)`);
  }

  // Post progress comment
  await getCommenter(ticket.number).notionFound(pages.length);

  return {
    notionContext:  pages,
    queryEmbedding: queryVector, // ← reused by readMemory — saves one Voyage API call
    currentStep:   "readNotion",
    logs: [`Notion RAG search returned ${pages.length} pages`],
  };
}

// ── Re-index all Notion pages ─────────────────────────────────────────────────

export async function reindexNotion(ragStore: RAGStore): Promise<void> {
  console.log(`\n[readNotion] Re-indexing Notion pages...`);

  const notion   = new NotionClient();
  const allPages = await notion.getAllPages();

  if (allPages.length === 0) {
    console.log(`[readNotion] ⚠ No Notion pages found — index empty`);
    return;
  }

  console.log(`[readNotion] Embedding ${allPages.length} pages via Voyage AI...`);

  // Build rich text per page: title + full excerpt
  const texts   = allPages.map((p) => `${p.title}\n\n${p.excerpt}`);
  const vectors = await embedBatch(texts);

  await ragStore.clear();
  for (let i = 0; i < allPages.length; i++) {
    ragStore.upsert({
      id:       allPages[i].url,
      text:     texts[i],
      vector:   vectors[i],
      metadata: allPages[i] as unknown as Record<string, unknown>,
    });
  }

  ragStore.setLastIndexed();
  await ragStore.save();

  console.log(`[readNotion] ✓ Indexed ${allPages.length} pages → Pinecone (namespace: notion)`);
}

// ── Smart delta sync — only re-embeds pages changed since last index ─────────

/**
 * Checks Notion for pages edited since the last index timestamp.
 *
 * Cost breakdown:
 *   - 1 cheap Notion API call to check for changes (always)
 *   - If 0 changes → returns immediately, zero Voyage/Pinecone cost
 *   - If N changes → embeds only those N pages → upserts to Pinecone
 */
export async function smartSyncNotion(): Promise<{ checked: number; updated: number }> {
  if (!process.env.VOYAGE_API_KEY) return { checked: 0, updated: 0 };

  const ragStore     = getStore();
  const lastIndexed  = ragStore.getLastIndexed();

  // If never indexed, do a full reindex instead
  if (!lastIndexed) {
    await reindexNotion(ragStore);
    return { checked: -1, updated: ragStore.size };
  }

  const notion       = new NotionClient();
  const changedPages = await notion.getPagesSince(lastIndexed);

  console.log(
    `[smartSync] Last indexed: ${lastIndexed.toLocaleString()} — ` +
    `${changedPages.length} page(s) changed since then`
  );

  if (changedPages.length === 0) {
    return { checked: 0, updated: 0 };   // ← nothing to do, zero cost
  }

  // Embed only the changed pages
  const texts   = changedPages.map((p) => `${p.title}\n\n${p.excerpt}`);
  const vectors = await embedBatch(texts);

  for (let i = 0; i < changedPages.length; i++) {
    ragStore.upsert({
      id:       changedPages[i].url,
      text:     texts[i],
      vector:   vectors[i],
      metadata: changedPages[i] as unknown as Record<string, unknown>,
    });
  }

  ragStore.setLastIndexed();   // update timestamp to now
  await ragStore.save();

  console.log(`[smartSync] ✅ Upserted ${changedPages.length} changed page(s) to Pinecone`);
  return { checked: changedPages.length, updated: changedPages.length };
}

// ── Add a single newly created page to the live index ─────────────────────────

export async function addPageToIndex(page: NotionPage): Promise<void> {
  if (!process.env.VOYAGE_API_KEY) return;

  try {
    const ragStore = getStore();
    const text     = `${page.title}\n\n${page.excerpt}`;
    const [vector] = await embedBatch([text]);

    ragStore.upsert({
      id:       page.url,
      text,
      vector,
      metadata: page as unknown as Record<string, unknown>,
    });
    await ragStore.save();
    console.log(`[readNotion] ✓ New page "${page.title}" added to RAG index`);
  } catch (err) {
    console.warn(`[readNotion] ⚠ Could not add new page to RAG index:`, (err as Error).message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a rich query from all available state context. */
function buildQuery(state: AgentState): string {
  const ticket  = state.ticket!;
  const parts: string[] = [ticket.title];

  if (ticket.labels.length > 0)  parts.push(`Labels: ${ticket.labels.join(", ")}`);
  if (ticket.body)                parts.push(ticket.body.slice(0, 600));
  if (state.projectConfig) {
    const cfg = state.projectConfig;
    parts.push(`Stack: ${cfg.language}${cfg.framework ? ` ${cfg.framework}` : ""}`);
  }

  return parts.join("\n");
}

/** Keyword fallback used when VOYAGE_API_KEY is absent. */
async function keywordFallback(
  title: string,
  labels: string[]
): Promise<Partial<AgentState>> {
  const notion      = new NotionClient();
  const queryTerms  = [title, ...labels].join(" ").slice(0, 200);
  let pages: NotionPage[] = [];

  try {
    pages = await notion.searchPages(queryTerms);
    console.log(`[readNotion] ✓ Keyword search: ${pages.length} page(s) found`);
  } catch (err) {
    console.warn(`[readNotion] ⚠ Notion search failed:`, err);
  }

  return {
    notionContext: pages,
    currentStep:  "readNotion",
    logs: [`Notion keyword search returned ${pages.length} pages`],
  };
}
