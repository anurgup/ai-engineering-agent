/**
 * Typed event bus for inter-agent communication.
 * All agents communicate exclusively through this bus — no direct imports across agent boundaries.
 */

import { EventEmitter } from "events";
import type { WorkflowTicket } from "../slack/workflow/types.js";

// ── Event Payloads ─────────────────────────────────────────────────────────────

export interface AgentEvents {
  // Ticket lifecycle
  "ticket.created":       { issueNumber: number; title: string; createdBy: string; channelId: string };
  "ticket.stage_changed": { issueNumber: number; fromStage: string; toStage: string; changedBy: string; ticket: WorkflowTicket };
  "ticket.closed":        { ticket: WorkflowTicket };
  "ticket.blocked":       { issueNumber: number; reason: string; changedBy: string };

  // Code pipeline
  "code.develop_requested": { issueNumber: number; mode: "ai" | "human"; assigneeSlackId?: string };
  "code.pr_created":        { issueNumber: number; prNumber: number; prUrl: string; branchName: string };
  "code.review_done":       { issueNumber: number; approved: boolean; feedback?: string };
  "code.tests_generated":   { issueNumber: number; testCases: string };

  // Knowledge / Notion
  "notion.sync_requested":  {};
  "knowledge.answer_ready": { question: string; answer: string; channelId: string; userId: string };

  // Standup
  "standup.post_requested": { channelId: string };

  // Notifications (Orchestrator handles all outbound Slack messages)
  "notify.user":    { userId: string; text: string };
  "notify.channel": { channel: string; text: string };

  // Routing — Orchestrator decides which agent handles a Slack message
  "slack.message": { text: string; userId: string; channelId: string; sessionId: string };
  "slack.response": { sessionId: string; text: string };
}

// ── Typed EventEmitter ─────────────────────────────────────────────────────────

class AgentEventBus extends EventEmitter {
  emit<K extends keyof AgentEvents>(event: K, payload: AgentEvents[K]): boolean {
    return super.emit(event as string, payload);
  }

  on<K extends keyof AgentEvents>(event: K, listener: (payload: AgentEvents[K]) => void): this {
    return super.on(event as string, listener);
  }

  once<K extends keyof AgentEvents>(event: K, listener: (payload: AgentEvents[K]) => void): this {
    return super.once(event as string, listener);
  }

  off<K extends keyof AgentEvents>(event: K, listener: (payload: AgentEvents[K]) => void): this {
    return super.off(event as string, listener);
  }
}

// Singleton — one bus for the entire process
export const eventBus = new AgentEventBus();
eventBus.setMaxListeners(50);
