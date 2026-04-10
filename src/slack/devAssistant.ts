/**
 * Dev Assistant — RAG-powered coding assistant for developers.
 *
 * Activated when a developer picks "i'll do it <number>".
 * Stays active until developer types "done <number>".
 *
 * Context injected per question (~400 tokens total):
 *   - Ticket details          (~50 tokens)
 *   - Relevant repo files     (~150 tokens — signatures + preview)
 *   - Past PRs / memory       (~80 tokens)
 *   - Notion docs             (~80 tokens)
 *   - Conversation history    (~60 tokens — rolling summary)
 *
 * Uses Claude Sonnet for coding quality, Haiku for follow-ups.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as fs   from "fs";
import * as path from "path";
import { RAGStore } from "../tools/ragStore.js";
import { embedText } from "../tools/embeddings.js";
import { indexRepoIfNeeded, searchRepo } from "./repoIndexer.js";

const REPO_PATH = process.env.LOCAL_REPO_PATH ?? path.resolve("repo");

const client = new Anthropic();

// ── Session state per developer ───────────────────────────────────────────────

interface DevSession {
  userId:        string;
  issueNumber:   number;
  issueTitle:    string;
  turns:         { role: "user" | "assistant"; content: string }[];
  summary:       string;
  createdAt:     Date;
  updatedAt:     Date;
}

const devSessions = new Map<string, DevSession>();

export function startDevSession(userId: string, issueNumber: number, issueTitle: string): void {
  devSessions.set(userId, {
    userId,
    issueNumber,
    issueTitle,
    turns:     [],
    summary:   "",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log(`[devAssistant] Started session for ${userId} on ticket #${issueNumber}`);

  // Kick off repo indexing in background (non-blocking)
  indexRepoIfNeeded().catch((e) => console.warn(`[devAssistant] Repo index failed:`, e));
}

export function endDevSession(userId: string): void {
  devSessions.delete(userId);
}

export function hasDevSession(userId: string): boolean {
  return devSessions.has(userId);
}

// ── Write-to-file intent detection ───────────────────────────────────────────

const WRITE_FILE_RE =
  /\b(save|write|create|add|commit)\b.{0,40}\b(file|test|junit|spec|class|method|endpoint|impl)\b/i;

function isWriteToFileRequest(question: string): boolean {
  return WRITE_FILE_RE.test(question) ||
    /\bsave to (file|repo|disk)\b/i.test(question) ||
    /\bcommit (it|this|the (test|file|code))\b/i.test(question);
}

// ── Main Q&A handler ──────────────────────────────────────────────────────────

export async function answerDevQuestion(userId: string, question: string): Promise<string> {
  const session = devSessions.get(userId);
  if (!session) return "No active dev session. Pick a ticket first.";

  session.updatedAt = new Date();
  session.turns.push({ role: "user", content: question });

  // Roll up history if too long
  if (session.turns.length > 8) {
    session.summary = await summarizeTurns(session.summary, session.turns.splice(0, 4));
  }

  // Build RAG context
  const context = await buildRAGContext(question, session);

  const historyText = session.summary ? `[Earlier context] ${session.summary}\n\n` : "";
  const recentTurns = session.turns
    .slice(-6)
    .map((t) => `${t.role === "user" ? "Developer" : "Assistant"}: ${t.content}`)
    .join("\n");

  // ── Write-to-file mode ────────────────────────────────────────────────────
  if (isWriteToFileRequest(question)) {
    return generateAndSaveFile(question, session, context, historyText + recentTurns);
  }

  // ── Normal Q&A mode ───────────────────────────────────────────────────────
  const systemPrompt =
    `You are a senior software engineer pair-programming with a developer.
You know their codebase AND their system architecture/domain knowledge deeply.
Use both technical (code patterns) AND functional (business rules, cluster/service/market mapping) context.
Be concise and practical. Match their existing conventions.
If asked to write code, show it in a code block.

Current ticket: #${session.issueNumber} — ${session.issueTitle}`;

  const userContent = [
    context ? `${context}\n\n---` : "",
    historyText + recentTurns,
    `Developer: ${question}`,
  ].filter(Boolean).join("\n");

  console.log(`[devAssistant] Answering for #${session.issueNumber} (~${Math.ceil(userContent.length / 4)} tokens)`);

  const msg = await client.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: 600,
    system:     systemPrompt,
    messages:   [{ role: "user", content: userContent }],
  });

  const block  = msg.content[0];
  const answer = block.type === "text" ? block.text : "Sorry, I couldn't generate a response.";

  session.turns.push({ role: "assistant", content: answer });
  devSessions.set(userId, session);

  return answer;
}

// ── Generate code + save to file + commit ─────────────────────────────────────

async function generateAndSaveFile(
  instruction: string,
  session:     DevSession,
  ragContext:  string,
  history:     string
): Promise<string> {
  console.log(`[devAssistant] Write-to-file request for #${session.issueNumber}`);

  // Step 1: Generate the code + infer file path
  const systemPrompt =
    `You are a senior software engineer. Generate production-ready code based on the instruction.

Output ONLY valid JSON:
{
  "filePath": "relative/path/from/repo/root/ClassName.java",
  "content": "full file content here",
  "description": "one sentence — what this file does"
}

Rules:
- filePath must match the project's package structure (e.g. src/main/java/com/ranga/... for Java)
- For JUnit tests use src/test/java/... path
- content must be complete, compilable code
- Match the exact coding conventions you see in the codebase`;

  const userContent = [
    ragContext ? `${ragContext}\n\n---` : "",
    history ? `${history}\n\n---` : "",
    `Instruction: ${instruction}`,
    `Ticket: #${session.issueNumber} — ${session.issueTitle}`,
    `\nGenerate the file JSON now.`,
  ].filter(Boolean).join("\n");

  const msg = await client.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: 1200,
    system:     systemPrompt,
    messages:   [{ role: "user", content: userContent }],
  });

  const block = msg.content[0];
  if (block.type !== "text") return "Failed to generate file.";

  const raw = block.text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();

  let parsed: { filePath?: string; content?: string; description?: string };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    // If JSON parse fails, return the raw code with a note
    session.turns.push({ role: "assistant", content: block.text });
    devSessions.set(session.userId, session);
    return `${block.text}\n\n_Type \`save to file\` to write this to the repo._`;
  }

  if (!parsed.filePath || !parsed.content) {
    return "Couldn't determine the file path. Please be more specific, e.g. _\"write junit for EmployeeDAOImpl and save to file\"_";
  }

  // Step 2: Write file to repo
  const fullPath = path.join(REPO_PATH, parsed.filePath);
  try {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, parsed.content, "utf-8");
    console.log(`[devAssistant] ✅ Wrote file: ${parsed.filePath}`);
  } catch (err) {
    return `❌ Failed to write file: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Step 3: Git add + commit
  try {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit(REPO_PATH);
    await git.add(parsed.filePath);
    await git.commit(
      `test(#${session.issueNumber}): ${parsed.description ?? `Add ${path.basename(parsed.filePath)}`}`
    );
    await git.push();
    console.log(`[devAssistant] ✅ Committed and pushed ${parsed.filePath}`);
  } catch (err) {
    // File written but commit failed — still report success for the file
    console.warn(`[devAssistant] Commit failed:`, err);
    const answer =
      `✅ *File written:* \`${parsed.filePath}\`\n\n` +
      `\`\`\`\n${parsed.content.slice(0, 800)}${parsed.content.length > 800 ? "\n... (truncated)" : ""}\n\`\`\`\n\n` +
      `⚠️ _Commit failed — please commit manually._`;
    session.turns.push({ role: "assistant", content: answer });
    devSessions.set(session.userId, session);
    return answer;
  }

  const answer =
    `✅ *File saved and committed!*\n\n` +
    `📄 \`${parsed.filePath}\`\n` +
    `_${parsed.description ?? ""}_\n\n` +
    `\`\`\`\n${parsed.content.slice(0, 600)}${parsed.content.length > 600 ? "\n... (truncated, full file in repo)" : ""}\n\`\`\`\n\n` +
    `_Committed to current branch. Type \`done ${session.issueNumber}\` when finished._`;

  session.turns.push({ role: "assistant", content: answer });
  devSessions.set(session.userId, session);
  return answer;
}

// ── RAG context builder ───────────────────────────────────────────────────────

async function buildRAGContext(question: string, session: DevSession): Promise<string> {
  if (!process.env.VOYAGE_API_KEY) return "";

  let queryVector: number[];
  try {
    queryVector = await embedText(`${question} ${session.issueTitle}`);
  } catch {
    return "";
  }

  const sections: string[] = [];

  // 1. Relevant repo files (most important — actual codebase)
  const repoFiles = await searchRepo(queryVector, 4);
  if (repoFiles.length > 0) {
    sections.push("## Your Codebase (relevant files)");
    for (const f of repoFiles) {
      const sigs = f.signatures.slice(0, 8).join("\n  ");
      sections.push(`### ${f.path}\n  ${sigs}\n  Preview: ${f.preview.slice(0, 150)}...`);
    }
  }

  // 2. Past PRs (memory store)
  const memoryStore = new RAGStore(
    process.env.MEMORY_VECTOR_STORE_PATH ?? path.resolve("data", "memory-vectors.json")
  );
  if (memoryStore.size > 0) {
    const memHits = memoryStore.search(queryVector, 2).filter((h) => h.score > 0.5);
    if (memHits.length > 0) {
      sections.push("## Past PRs (similar work)");
      memHits.forEach((h) => {
        const meta = h.metadata as { type?: string; number?: number; title?: string; filesChanged?: string[] };
        const files = (meta.filesChanged ?? []).slice(0, 3).join(", ");
        sections.push(`- PR #${meta.number}: ${meta.title}${files ? ` (${files})` : ""}`);
      });
    }
  }

  // 3. Notion docs — architecture + functional + domain knowledge
  const notionStore = new RAGStore(
    process.env.NOTION_VECTOR_STORE_PATH ?? path.resolve("data", "notion-vectors.json")
  );
  if (notionStore.size > 0) {
    const notionHits = notionStore.search(queryVector, 3).filter((h) => h.score > 0.45);
    if (notionHits.length > 0) {
      sections.push("## Architecture & Domain Knowledge");
      notionHits.forEach((h) => {
        const meta    = h.metadata as { title?: string; excerpt?: string };
        const excerpt = (meta.excerpt ?? h.text).slice(0, 200);
        sections.push(`### ${meta.title ?? "Doc"}\n${excerpt}`);
      });
    }
  }

  return sections.join("\n");
}

// ── Rolling summary ───────────────────────────────────────────────────────────

async function summarizeTurns(
  existing: string,
  turns: { role: "user" | "assistant"; content: string }[]
): Promise<string> {
  const dialogue = turns
    .map((t) => `${t.role === "user" ? "Dev" : "Bot"}: ${t.content}`)
    .join("\n");

  const prior = existing ? `Prior: ${existing}\n\n` : "";

  const msg = await client.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: 80,
    messages:   [{
      role:    "user",
      content: `${prior}Summarize in ≤60 tokens — key technical decisions and code discussed:\n\n${dialogue}`,
    }],
  });

  const block = msg.content[0];
  return block.type === "text" ? block.text.trim() : existing;
}
