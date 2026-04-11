/**
 * Repo Indexer — scans the local repo, extracts file content + signatures,
 * and stores them in a vector store for the dev assistant to query.
 *
 * Store path: data/repo-vectors.json
 * Re-indexes every 6 hours or when forced.
 *
 * Indexed content per file:
 *   - Method/class signatures (compact, ~40 tokens)
 *   - File path + language
 *   - First 500 chars of content (for context)
 */

import * as fs   from "fs";
import * as path from "path";
import { RAGStore } from "../tools/ragStore.js";
import { embedBatch } from "../tools/embeddings.js";
import { extractSignatures } from "../teams/signatureExtractor.js";

const REPO_VECTOR_STORE_PATH = path.resolve("data", "repo-vectors.json");
const REPO_PATH = process.env.LOCAL_REPO_PATH ?? path.resolve("repo");

// File extensions to index
const INDEXED_EXTENSIONS = new Set([
  ".java", ".py", ".ts", ".js", ".tsx", ".jsx",
  ".go", ".rb", ".cs", ".kt", ".swift",
]);

// Directories to skip
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target",
  "__pycache__", ".gradle", ".mvn", "coverage", ".next",
]);

// Max files to index (keep token cost low)
const MAX_FILES = 150;

let repoStore: RAGStore | null = null;

export function getRepoStore(): RAGStore {
  if (!repoStore) {
    repoStore = new RAGStore(REPO_VECTOR_STORE_PATH);
  }
  return repoStore;
}

/**
 * Index the repo if stale (>6h) or empty.
 * Safe to call on every message — returns immediately if fresh.
 */
export async function indexRepoIfNeeded(force = false): Promise<void> {
  if (!process.env.VOYAGE_API_KEY) return;

  const store = getRepoStore();
  if (!force && !store.isStale(6) && store.size > 0) {
    return; // fresh enough
  }

  if (!fs.existsSync(REPO_PATH)) {
    console.warn(`[repoIndexer] Repo not found at ${REPO_PATH} — skipping index`);
    return;
  }

  console.log(`[repoIndexer] Indexing repo at ${REPO_PATH}...`);
  const files = collectFiles(REPO_PATH, MAX_FILES);
  console.log(`[repoIndexer] Found ${files.length} source files`);

  if (files.length === 0) return;

  await store.clear();

  // Build text chunks for each file
  const chunks: { id: string; text: string; metadata: Record<string, unknown> }[] = [];

  for (const filePath of files) {
    try {
      const content  = fs.readFileSync(filePath, "utf-8");
      const relPath  = path.relative(REPO_PATH, filePath);
      const sigs     = extractSignatures(relPath, content);
      const sigText  = sigs.signatures.join("\n");
      const preview  = content.slice(0, 500).replace(/\s+/g, " ");

      // One chunk per file: signatures + preview
      const text = `File: ${relPath}\n${sigText}\n\nPreview:\n${preview}`;

      chunks.push({
        id:       relPath,
        text,
        metadata: {
          path:       relPath,
          language:   sigs.language,
          signatures: sigs.signatures,
          preview,
        },
      });
    } catch {
      // skip unreadable files
    }
  }

  // Embed in batches
  const texts = chunks.map((c) => c.text);
  let vectors: number[][];
  try {
    vectors = await embedBatch(texts);
  } catch (err) {
    console.error(`[repoIndexer] Embedding failed:`, err);
    return;
  }

  // Store
  for (let i = 0; i < chunks.length; i++) {
    store.upsert({ ...chunks[i], vector: vectors[i] });
  }
  store.setLastIndexed();
  await store.save();

  console.log(`[repoIndexer] ✅ Indexed ${chunks.length} files into repo vector store`);
}

/**
 * Search the repo store for files relevant to a query.
 * Returns top-5 matches with signatures + preview.
 */
export async function searchRepo(
  queryVector: number[],
  topK = 5
): Promise<Array<{ path: string; language: string; signatures: string[]; preview: string; score: number }>> {
  const store = getRepoStore();
  if (store.size === 0) return [];

  return (await store.search(queryVector, topK))
    .filter((h) => h.score > 0.4)
    .map((h) => ({
      path:       (h.metadata.path       as string)   ?? h.id,
      language:   (h.metadata.language   as string)   ?? "unknown",
      signatures: (h.metadata.signatures as string[]) ?? [],
      preview:    (h.metadata.preview    as string)   ?? "",
      score:      h.score,
    }));
}

// ── File collection ───────────────────────────────────────────────────────────

function collectFiles(dir: string, maxFiles: number): string[] {
  const results: string[] = [];
  collectRecursive(dir, results, maxFiles);
  return results;
}

function collectRecursive(dir: string, results: string[], maxFiles: number): void {
  if (results.length >= maxFiles) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxFiles) break;

    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        collectRecursive(path.join(dir, entry.name), results, maxFiles);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (INDEXED_EXTENSIONS.has(ext)) {
        results.push(path.join(dir, entry.name));
      }
    }
  }
}
