/**
 * In-memory store for workflow tickets and Slack user registry.
 * Persists to data/workflow.json so restarts don't lose state.
 */

import * as fs   from "fs";
import * as path from "path";
import type { WorkflowTicket, SlackUser } from "./types.js";

const STORE_PATH = path.resolve("data", "workflow.json");

interface WorkflowStore {
  tickets: Record<number, WorkflowTicket>;
  users:   Record<string, SlackUser>;   // keyed by Slack user ID
}

let store: WorkflowStore = { tickets: {}, users: {} };

// ── Persistence ────────────────────────────────────────────────────────────────

export function loadStore(): void {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as WorkflowStore;
      // Re-hydrate Date objects
      for (const t of Object.values(parsed.tickets)) {
        t.createdAt      = new Date(t.createdAt);
        t.stageChangedAt = new Date(t.stageChangedAt);
        t.updatedAt      = new Date(t.updatedAt);
        t.history        = t.history.map((h) => ({ ...h, at: new Date(h.at) }));
      }
      store = parsed;
    }
  } catch {
    store = { tickets: {}, users: {} };
  }
}

export function saveStore(): void {
  const dir = path.dirname(STORE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

// ── Ticket CRUD ────────────────────────────────────────────────────────────────

export function getTicket(issueNumber: number): WorkflowTicket | undefined {
  return store.tickets[issueNumber];
}

export function getAllTickets(): WorkflowTicket[] {
  return Object.values(store.tickets);
}

export function saveTicket(ticket: WorkflowTicket): void {
  ticket.updatedAt = new Date();
  store.tickets[ticket.issueNumber] = ticket;
  saveStore();
}

export function getTicketsByStage(stage: WorkflowTicket["stage"]): WorkflowTicket[] {
  return Object.values(store.tickets).filter((t) => t.stage === stage);
}

export function getTicketsByAssignee(slackUserId: string): WorkflowTicket[] {
  return Object.values(store.tickets).filter(
    (t) => t.assigneeSlackId === slackUserId && t.stage !== "done"
  );
}

// ── User registry ──────────────────────────────────────────────────────────────

export function registerUser(user: SlackUser): void {
  store.users[user.id] = user;
  saveStore();
}

export function getUser(slackUserId: string): SlackUser | undefined {
  return store.users[slackUserId];
}

export function getAllUsers(): SlackUser[] {
  return Object.values(store.users);
}

export function findUserByName(name: string): SlackUser | undefined {
  const lower = name.toLowerCase();
  return Object.values(store.users).find(
    (u) =>
      u.name.toLowerCase().includes(lower) ||
      u.realName.toLowerCase().includes(lower)
  );
}

// Load on module init
loadStore();
