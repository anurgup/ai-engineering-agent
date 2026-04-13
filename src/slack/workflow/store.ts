/**
 * Workflow store — persists tickets and users to MongoDB Atlas.
 * Falls back to data/workflow.json if MONGODB_URI is not set.
 *
 * Public API is identical to the original file-based version so no
 * callers need to change.
 */

import * as fs   from "fs";
import * as path from "path";
import type { WorkflowTicket, SlackUser } from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────────────

interface WorkflowStore {
  tickets: Record<number, WorkflowTicket>;
  users:   Record<string, SlackUser>;
}

// ── In-memory cache (always kept in sync) ─────────────────────────────────────

let store: WorkflowStore = { tickets: {}, users: {} };

// ── File-based fallback ────────────────────────────────────────────────────────

const STORE_PATH = path.resolve("data", "workflow.json");

function loadFromFile(): void {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw    = fs.readFileSync(STORE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as WorkflowStore;
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

function saveToFile(): void {
  const dir = path.dirname(STORE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

// ── MongoDB layer (Mongoose) ───────────────────────────────────────────────────

let mongoConnected = false;

// Lazy-load mongoose only when MONGODB_URI is present to avoid import errors
// if the package is somehow missing in a non-Mongo environment.
async function connectMongo(): Promise<boolean> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return false;

  try {
    const mongoose = await import("mongoose");

    if (mongoose.default.connection.readyState === 0) {
      await mongoose.default.connect(uri, { dbName: "agent" });
      console.log("[store] Connected to MongoDB Atlas");
    }

    return true;
  } catch (err) {
    console.warn("[store] MongoDB connection failed — using file fallback:", err);
    return false;
  }
}

// Mongoose schema types (defined lazily to avoid top-level import issues)
type MongooseModel<T> = {
  findOne: (filter: object) => Promise<T | null>;
  find:    (filter?: object) => Promise<T[]>;
  findOneAndUpdate: (filter: object, update: object, opts: object) => Promise<T | null>;
};

let TicketModel:  MongooseModel<WorkflowTicket> | null = null;
let UserModel:    MongooseModel<SlackUser>       | null = null;

async function getModels() {
  if (TicketModel && UserModel) return { TicketModel, UserModel };

  const mongoose = await import("mongoose");
  const { Schema } = mongoose.default;

  const historySchema = new Schema({
    stage:     String,
    changedBy: String,
    note:      String,
    at:        Date,
  }, { _id: false });

  const ticketSchema = new Schema({
    issueNumber:     { type: Number, required: true, unique: true },
    title:           String,
    stage:           String,
    createdBy:       String,
    assigneeSlackId: String,
    assigneeName:    String,
    assigneeRole:    String,
    developerMode:   String,
    testMode:        String,
    githubUrl:       String,
    prUrl:           String,
    prNumber:        Number,
    testCases:       String,
    createdAt:       Date,
    stageChangedAt:  Date,
    updatedAt:       Date,
    history:         [historySchema],
  });

  const userSchema = new Schema({
    id:       { type: String, required: true, unique: true },
    name:     String,
    realName: String,
    email:    String,
    role:     String,
  });

  // Re-use existing models if already compiled (hot-reload safety)
  TicketModel = (
    mongoose.default.models["WorkflowTicket"] ??
    mongoose.default.model("WorkflowTicket", ticketSchema)
  ) as unknown as MongooseModel<WorkflowTicket>;

  UserModel = (
    mongoose.default.models["SlackUser"] ??
    mongoose.default.model("SlackUser", userSchema)
  ) as unknown as MongooseModel<SlackUser>;

  return { TicketModel, UserModel };
}

async function loadFromMongo(): Promise<void> {
  try {
    const { TicketModel: TM, UserModel: UM } = await getModels();

    const tickets = await TM.find();
    const users   = await UM.find();

    store.tickets = {};
    for (const t of tickets) {
      store.tickets[t.issueNumber] = t as unknown as WorkflowTicket;
    }

    store.users = {};
    for (const u of users) {
      const user = u as unknown as SlackUser;
      store.users[user.id] = user;
    }

    console.log(`[store] Loaded ${tickets.length} tickets, ${users.length} users from MongoDB`);
  } catch (err) {
    console.warn("[store] Failed to load from MongoDB:", err);
  }
}

// Async fire-and-forget upsert — doesn't block callers
function persistTicketToMongo(ticket: WorkflowTicket): void {
  if (!mongoConnected) return;
  getModels()
    .then(({ TicketModel: TM }) =>
      TM.findOneAndUpdate(
        { issueNumber: ticket.issueNumber },
        ticket as unknown as object,
        { upsert: true, new: true }
      )
    )
    .catch((err) => console.warn("[store] MongoDB ticket upsert failed:", err));
}

function persistUserToMongo(user: SlackUser): void {
  if (!mongoConnected) return;
  getModels()
    .then(({ UserModel: UM }) =>
      UM.findOneAndUpdate(
        { id: user.id },
        user as unknown as object,
        { upsert: true, new: true }
      )
    )
    .catch((err) => console.warn("[store] MongoDB user upsert failed:", err));
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

export async function loadStore(): Promise<void> {
  mongoConnected = await connectMongo();

  if (mongoConnected) {
    await loadFromMongo();
  } else {
    loadFromFile();
  }
}

export function saveStore(): void {
  if (!mongoConnected) {
    saveToFile();
  }
  // With Mongo, individual saves happen in saveTicket / registerUser
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

  if (mongoConnected) {
    persistTicketToMongo(ticket);
  } else {
    saveToFile();
  }
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

  if (mongoConnected) {
    persistUserToMongo(user);
  } else {
    saveToFile();
  }
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

// ── Init — load on module startup ─────────────────────────────────────────────
// loadStore() is async now; we call it and let it run. The in-memory store
// starts empty and is populated once the promise resolves (~100ms on Mongo).
loadStore().catch((err) => console.error("[store] Init failed:", err));
