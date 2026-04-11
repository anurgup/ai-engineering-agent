/**
 * Knowledge Agent
 *
 * Responsibilities:
 * - Answer technical/process questions using Pinecone RAG
 * - Manage Notion index (full reindex + smart delta sync)
 * - Warm RAG indexes at startup
 * - Listen for notion.sync_requested events
 */

import { eventBus } from "../../shared/eventBus.js";
import { answerKnowledgeQuestion } from "../../slack/knowledgeBase.js";
import { smartSyncNotion, reindexNotion } from "../../agent/nodes/readNotion.js";
import { RAGStore } from "../../tools/ragStore.js";

// ── Startup warm-up ────────────────────────────────────────────────────────────

export async function warmKnowledgeIndexes(): Promise<void> {
  console.log("[knowledge] Pre-warming RAG indexes...");
  try {
    const notionStore = new RAGStore();
    if (notionStore.isStale(24)) {
      console.log("[knowledge] Notion index stale — reindexing...");
      await reindexNotion(notionStore);
      console.log(`[knowledge] ✅ Notion indexed (${notionStore.size} pages)`);
    } else {
      console.log("[knowledge] ✅ Notion index fresh — skipping");
    }
  } catch (err) {
    console.error("[knowledge] Warm-up failed:", err);
  }
}

// ── Event listeners ────────────────────────────────────────────────────────────

export function initKnowledgeAgent(): void {
  // Triggered by Standup Agent every 6h or manually
  eventBus.on("notion.sync_requested", async () => {
    console.log("[knowledge] Notion sync requested via event bus");
    try {
      const result = await smartSyncNotion();
      if (result.updated === 0) {
        console.log("[knowledge] No Notion changes detected");
      } else {
        console.log(`[knowledge] Synced ${result.updated} changed pages`);
      }
    } catch (err) {
      console.error("[knowledge] Sync failed:", err);
    }
  });

  console.log("[knowledge] ✅ Knowledge Agent initialized");
}

// ── Public API for Slack router ────────────────────────────────────────────────

export async function handleKnowledgeQuestion(
  question: string
): Promise<string> {
  return answerKnowledgeQuestion(question);
}
