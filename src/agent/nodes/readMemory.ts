import { Octokit }               from "@octokit/rest";
import { AgentState, MemoryEntry } from "../state.js";
import { RAGStore }                from "../../tools/ragStore.js";
import { embedText, embedBatch }   from "../../tools/embeddings.js";
import * as path                   from "path";

const MEMORY_STORE_PATH = process.env.MEMORY_STORE_PATH
  ?? path.resolve("data", "memory-vectors.json");

const MAX_AGE_HOURS = 24;
const TOP_K         = 5;
const MIN_SCORE     = 0.55;
const MAX_PRS       = 100;
const MAX_ISSUES    = 100;
const MAX_FILES_PER_PR = 30;

// Shared store — reused across pipeline runs in the same process
let store: RAGStore | null = null;

function getStore(): RAGStore {
  if (!store) store = new RAGStore(MEMORY_STORE_PATH);
  return store;
}

// ── Main node ─────────────────────────────────────────────────────────────────

export async function readMemory(state: AgentState): Promise<Partial<AgentState>> {

  if (!process.env.VOYAGE_API_KEY) {
    console.log(`\n[readMemory] ⚠ VOYAGE_API_KEY not set — skipping memory`);
    return { memoryContext: [], currentStep: "readMemory" };
  }

  const memStore = getStore();

  // ── Re-index if stale or empty ──────────────────────────────────────────────
  if (memStore.isStale(MAX_AGE_HOURS) || memStore.size === 0) {
    await reindexMemory(memStore);
  } else {
    const last = memStore.getLastIndexed();
    console.log(
      `\n[readMemory] Using cached memory — ${memStore.size} entries` +
      ` (last indexed: ${last?.toLocaleString() ?? "unknown"})`
    );
  }

  // Nothing in memory yet (brand-new repo)
  if (memStore.size === 0) {
    console.log(`[readMemory] Memory index is empty — no past work yet`);
    return { memoryContext: [], currentStep: "readMemory", logs: ["Memory index empty"] };
  }

  // ── Semantic search ─────────────────────────────────────────────────────────
  const query  = buildQuery(state);
  const vector = await embedText(query);
  const hits   = memStore.search(vector, TOP_K);
  const relevant = hits.filter((h) => h.score >= MIN_SCORE);

  const memoryContext: MemoryEntry[] = relevant.map(
    (h) => h.metadata as unknown as MemoryEntry
  );

  console.log(`[readMemory] ✓ ${memoryContext.length} relevant past entries found:`);
  relevant.forEach((h, i) => {
    const e = h.metadata as unknown as MemoryEntry;
    console.log(
      `  ${i + 1}. [${e.type.toUpperCase()} #${e.number}] "${e.title}"` +
      `  score=${h.score.toFixed(3)}`
    );
    if (e.filesChanged.length > 0) {
      console.log(`       Files: ${e.filesChanged.slice(0, 3).join(", ")}` +
        (e.filesChanged.length > 3 ? ` +${e.filesChanged.length - 3} more` : ""));
    }
  });

  if (memoryContext.length === 0) {
    console.log(`[readMemory]   (no entries above threshold — proceeding without memory)`);
  }

  return {
    memoryContext,
    currentStep: "readMemory",
    logs: [`Memory search: ${memoryContext.length} relevant past entries`],
  };
}

// ── Re-index all merged PRs and closed issues ─────────────────────────────────

async function reindexMemory(memStore: RAGStore): Promise<void> {
  console.log(`\n[readMemory] Re-indexing GitHub PRs and issues...`);

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const owner   = process.env.GITHUB_OWNER!;
  const repo    = process.env.GITHUB_REPO!;

  // ── Fetch merged PRs ────────────────────────────────────────────────────────
  let mergedPRs: MemoryEntry[] = [];
  try {
    const res = await octokit.pulls.list({
      owner, repo,
      state:     "closed",
      per_page:  MAX_PRS,
      sort:      "updated",
      direction: "desc",
    });

    const merged = res.data.filter((pr) => pr.merged_at);
    console.log(`[readMemory]   ${merged.length} merged PRs found`);

    for (const pr of merged) {
      let filesChanged: string[] = [];
      try {
        const filesRes = await octokit.pulls.listFiles({
          owner, repo,
          pull_number: pr.number,
          per_page: MAX_FILES_PER_PR,
        });
        filesChanged = filesRes.data.map((f) => f.filename);
      } catch {
        // non-fatal — continue without file list
      }

      mergedPRs.push({
        type:  "pr",
        number: pr.number,
        title:  pr.title,
        summary: (pr.body ?? "").slice(0, 800),
        filesChanged,
        url:   pr.html_url,
      });
    }
  } catch (err) {
    console.warn(`[readMemory] ⚠ Could not fetch PRs:`, (err as Error).message);
  }

  // ── Fetch closed issues (exclude PRs which also appear as issues) ───────────
  let closedIssues: MemoryEntry[] = [];
  try {
    const res = await octokit.issues.listForRepo({
      owner, repo,
      state:     "closed",
      per_page:  MAX_ISSUES,
      sort:      "updated",
      direction: "desc",
    });

    const issues = res.data.filter((i) => !i.pull_request);
    console.log(`[readMemory]   ${issues.length} closed issues found`);

    closedIssues = issues.map((issue) => ({
      type:         "issue" as const,
      number:       issue.number,
      title:        issue.title,
      summary:      (issue.body ?? "").slice(0, 600),
      filesChanged: [],
      url:          issue.html_url,
    }));
  } catch (err) {
    console.warn(`[readMemory] ⚠ Could not fetch issues:`, (err as Error).message);
  }

  const all = [...mergedPRs, ...closedIssues];
  if (all.length === 0) {
    console.log(`[readMemory] Nothing to index yet`);
    return;
  }

  // ── Embed all entries ───────────────────────────────────────────────────────
  console.log(`[readMemory] Embedding ${all.length} entries via Voyage AI...`);
  const texts   = all.map(buildMemoryText);
  const vectors = await embedBatch(texts);

  memStore.clear();
  for (let i = 0; i < all.length; i++) {
    memStore.upsert({
      id:       all[i].url,
      text:     texts[i],
      vector:   vectors[i],
      metadata: all[i] as unknown as Record<string, unknown>,
    });
  }

  memStore.setLastIndexed();
  memStore.save();

  console.log(`[readMemory] ✓ Indexed ${all.length} entries → data/memory-vectors.json`);
}

// ── Add a single new PR to the live index after it's pushed ──────────────────

export async function addPRToMemory(entry: MemoryEntry): Promise<void> {
  if (!process.env.VOYAGE_API_KEY) return;

  try {
    const memStore = getStore();
    const text     = buildMemoryText(entry);
    const [vector] = await embedBatch([text]);

    memStore.upsert({
      id:       entry.url,
      text,
      vector,
      metadata: entry as unknown as Record<string, unknown>,
    });
    memStore.save();

    console.log(`[readMemory] ✓ PR #${entry.number} "${entry.title}" added to memory`);
  } catch (err) {
    console.warn(`[readMemory] ⚠ Could not add PR to memory:`, (err as Error).message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildMemoryText(entry: MemoryEntry): string {
  const parts = [`[${entry.type.toUpperCase()} #${entry.number}] ${entry.title}`];
  if (entry.summary)              parts.push(entry.summary);
  if (entry.filesChanged.length > 0)
    parts.push(`Files changed: ${entry.filesChanged.join(", ")}`);
  return parts.join("\n");
}

function buildQuery(state: AgentState): string {
  const ticket = state.ticket!;
  const parts  = [ticket.title];
  if (ticket.labels.length > 0) parts.push(`Labels: ${ticket.labels.join(", ")}`);
  if (ticket.body)               parts.push(ticket.body.slice(0, 500));
  return parts.join("\n");
}
