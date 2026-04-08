/**
 * Simple JSON-file-backed vector store with cosine similarity search.
 * No external service required — works locally and on Railway/Render.
 *
 * File location: data/notion-vectors.json (override via NOTION_VECTOR_STORE_PATH)
 */

import * as fs   from "fs";
import * as path from "path";

export interface VectorEntry {
  id:       string;
  text:     string;
  vector:   number[];
  metadata: Record<string, unknown>;
}

const META_ID = "__meta__";

export class RAGStore {
  private entries: VectorEntry[] = [];
  private readonly storePath: string;

  constructor(storePath?: string) {
    this.storePath =
      storePath ??
      process.env.NOTION_VECTOR_STORE_PATH ??
      path.resolve("data", "notion-vectors.json");

    this.load();
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, "utf-8");
        this.entries = JSON.parse(raw) as VectorEntry[];
      }
    } catch {
      this.entries = [];
    }
  }

  save(): void {
    const dir = path.dirname(this.storePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.storePath, JSON.stringify(this.entries, null, 2));
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  upsert(entry: VectorEntry): void {
    const idx = this.entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      this.entries[idx] = entry;
    } else {
      this.entries.push(entry);
    }
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    // exclude the __meta__ entry from count
    return this.entries.filter((e) => e.id !== META_ID).length;
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  search(
    queryVector: number[],
    topK = 5
  ): Array<VectorEntry & { score: number }> {
    return this.entries
      .filter((e) => e.id !== META_ID && e.vector.length > 0)
      .map((e) => ({ ...e, score: cosineSimilarity(queryVector, e.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  // ── Metadata ───────────────────────────────────────────────────────────────

  getLastIndexed(): Date | null {
    const meta = this.entries.find((e) => e.id === META_ID);
    if (meta?.metadata?.indexedAt) {
      return new Date(meta.metadata.indexedAt as string);
    }
    return null;
  }

  setLastIndexed(): void {
    this.upsert({
      id:       META_ID,
      text:     "",
      vector:   [],
      metadata: { indexedAt: new Date().toISOString() },
    });
  }

  isStale(maxAgeHours = 24): boolean {
    const last = this.getLastIndexed();
    if (!last) return true;
    const ageMs = Date.now() - last.getTime();
    return ageMs > maxAgeHours * 60 * 60 * 1000;
  }
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
