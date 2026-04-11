/**
 * Pinecone-backed vector store.
 *
 * One Pinecone index ("agent-rag") with three namespaces:
 *   notion  — Notion pages (architecture, cluster, market docs)
 *   memory  — Past PRs + closed issues
 *   repo    — Repo file signatures (dev assistant)
 *
 * Timestamps + counts are stored in data/index-meta.json (lightweight, no vectors).
 * This survives Railway redeploys; the vectors themselves live in Pinecone permanently.
 *
 * Required env vars:
 *   PINECONE_API_KEY   — from app.pinecone.io
 *   PINECONE_INDEX     — index name (default: "agent-rag")
 *
 * Dimension: 512 (Voyage AI voyage-3-lite)
 * Metric:    cosine
 */

import { Pinecone } from "@pinecone-database/pinecone";
import type { Index } from "@pinecone-database/pinecone";
import * as fs   from "fs";
import * as path from "path";

export interface VectorEntry {
  id:       string;
  text:     string;
  vector:   number[];
  metadata: Record<string, unknown>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const INDEX_NAME  = process.env.PINECONE_INDEX ?? "agent-rag";
const DIMENSION   = 512;   // voyage-3-lite output dimension
const UPSERT_BATCH = 100;  // Pinecone max per upsert call
const META_PATH   = path.resolve("data", "index-meta.json");

// ── Pinecone singleton ────────────────────────────────────────────────────────

let _pc:    Pinecone | null = null;
let _index: Index    | null = null;

function getPineconeClient(): Pinecone {
  if (!_pc) {
    const apiKey = process.env.PINECONE_API_KEY;
    if (!apiKey) throw new Error("PINECONE_API_KEY is not set. Get a free key at https://app.pinecone.io");
    _pc = new Pinecone({ apiKey });
  }
  return _pc;
}

async function getPineconeIndex(): Promise<Index> {
  if (_index) return _index;

  const pc = getPineconeClient();

  // Create index if it doesn't exist yet (free serverless, us-east-1)
  try {
    const list = await pc.listIndexes();
    const exists = (list.indexes ?? []).some((i) => i.name === INDEX_NAME);

    if (!exists) {
      console.log(`[ragStore] Creating Pinecone index "${INDEX_NAME}" (dimension=${DIMENSION})...`);
      await pc.createIndex({
        name:      INDEX_NAME,
        dimension: DIMENSION,
        metric:    "cosine",
        spec: {
          serverless: { cloud: "aws", region: "us-east-1" },
        },
      });

      // Poll until ready (usually < 30s)
      console.log(`[ragStore] Waiting for index to be ready...`);
      for (let i = 0; i < 30; i++) {
        const desc = await pc.describeIndex(INDEX_NAME);
        if (desc.status?.ready) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      console.log(`[ragStore] ✅ Pinecone index "${INDEX_NAME}" is ready`);
    }
  } catch (err) {
    // If already exists or non-fatal, log and continue
    console.warn(`[ragStore] Index init warning:`, (err as Error).message);
  }

  _index = pc.index(INDEX_NAME);
  return _index;
}

// ── Meta JSON (timestamps + counts — no vectors) ──────────────────────────────

interface IndexMeta {
  [namespace: string]: { indexedAt: string; count: number };
}

function loadMeta(): IndexMeta {
  try {
    if (fs.existsSync(META_PATH)) {
      return JSON.parse(fs.readFileSync(META_PATH, "utf-8")) as IndexMeta;
    }
  } catch { /* fresh start */ }
  return {};
}

function writeMeta(meta: IndexMeta): void {
  fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
}

// ── storePath → namespace mapping (backward compat with old callers) ──────────

function resolveNamespace(storePath?: string): string {
  if (!storePath) return "notion";
  const base = path.basename(storePath, ".json");        // "notion-vectors"
  if (base.includes("memory") || base.includes("mem")) return "memory";
  if (base.includes("repo"))                             return "repo";
  return "notion";
}

// ── RAGStore ──────────────────────────────────────────────────────────────────

export class RAGStore {
  private readonly namespace: string;
  private buffer: VectorEntry[] = [];   // pending upserts, flushed on save()
  private cachedCount: number;

  constructor(storePath?: string) {
    this.namespace   = resolveNamespace(storePath);
    const meta       = loadMeta();
    this.cachedCount = meta[this.namespace]?.count ?? 0;
  }

  // ── Write (sync buffer, async flush) ───────────────────────────────────────

  /** Stage an entry for upsert. Call save() to flush to Pinecone. */
  upsert(entry: VectorEntry): void {
    this.buffer.push(entry);
    this.cachedCount++;
  }

  /** Flush buffered upserts to Pinecone. Must be awaited. */
  async save(): Promise<void> {
    if (this.buffer.length === 0) return;

    const index = await getPineconeIndex();
    const ns    = index.namespace(this.namespace);

    for (let i = 0; i < this.buffer.length; i += UPSERT_BATCH) {
      const batch = this.buffer.slice(i, i + UPSERT_BATCH);
      await ns.upsert({
        records: batch.map((e) => ({
          id:       e.id,
          values:   e.vector,
          metadata: { ...e.metadata, __text: e.text },
        })),
      });
    }

    console.log(`[ragStore:${this.namespace}] Flushed ${this.buffer.length} vectors to Pinecone`);
    this.buffer = [];
  }

  // ── Search (async — queries Pinecone) ──────────────────────────────────────

  async search(
    queryVector: number[],
    topK = 5
  ): Promise<Array<VectorEntry & { score: number }>> {
    const index  = await getPineconeIndex();
    const result = await index.namespace(this.namespace).query({
      vector:          queryVector,
      topK,
      includeMetadata: true,
    });

    return (result.matches ?? []).map((m) => {
      const raw  = { ...(m.metadata ?? {}) } as Record<string, unknown>;
      const text = (raw.__text as string) ?? "";
      delete raw.__text;
      return {
        id:       m.id,
        text,
        vector:   [],   // Pinecone doesn't return vectors in query results
        metadata: raw,
        score:    m.score ?? 0,
      };
    });
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  /** Delete all vectors in this namespace. */
  async clear(): Promise<void> {
    try {
      const index = await getPineconeIndex();
      await index.namespace(this.namespace).deleteAll();
    } catch (err) {
      console.warn(`[ragStore:${this.namespace}] clear() warning:`, (err as Error).message);
    }
    this.buffer      = [];
    this.cachedCount = 0;
  }

  // ── Size ───────────────────────────────────────────────────────────────────

  /** Cached count from last reindex. Updated by setLastIndexed(). */
  get size(): number {
    return this.cachedCount;
  }

  // ── Timestamps ─────────────────────────────────────────────────────────────

  getLastIndexed(): Date | null {
    const ts = loadMeta()[this.namespace]?.indexedAt;
    return ts ? new Date(ts) : null;
  }

  setLastIndexed(): void {
    const meta = loadMeta();
    meta[this.namespace] = {
      indexedAt: new Date().toISOString(),
      count:     this.cachedCount,
    };
    writeMeta(meta);
  }

  isStale(maxAgeHours = 24): boolean {
    const last = this.getLastIndexed();
    if (!last) return true;
    return Date.now() - last.getTime() > maxAgeHours * 3_600_000;
  }
}
