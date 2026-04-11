/**
 * Standup Agent
 *
 * Responsibilities:
 * - Post daily standup digest at 9am weekdays
 * - Check SLA breaches every 30 minutes
 * - Trigger Notion sync every 6h via event bus
 * - Respond to on-demand standup requests
 */

import { eventBus } from "../../shared/eventBus.js";
import {
  buildStandupMessage,
  postStandup,
  scheduleStandup,
  scheduleSLAChecker,
} from "../../slack/standup.js";

const STATUS_CHANNEL = process.env.SLACK_STATUS_CHANNEL ?? "general";

// ── Notion sync scheduler (delegates to Knowledge Agent via event bus) ────────

function scheduleNotionSync(): void {
  const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

  setInterval(() => {
    console.log("[standup] Triggering Notion sync via event bus");
    eventBus.emit("notion.sync_requested", {});
  }, INTERVAL_MS);

  console.log("[standup] Notion sync scheduled (every 6h)");
}

// ── Event listeners ────────────────────────────────────────────────────────────

export function initStandupAgent(): void {
  // On-demand standup triggered by Orchestrator
  eventBus.on("standup.post_requested", async ({ channelId }) => {
    const message = buildStandupMessage();
    eventBus.emit("notify.channel", { channel: channelId, text: message });
  });

  // Start all schedulers
  scheduleStandup();
  scheduleSLAChecker();
  scheduleNotionSync();

  console.log("[standup] ✅ Standup Agent initialized");
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function getStandupMessage(): string {
  return buildStandupMessage();
}
