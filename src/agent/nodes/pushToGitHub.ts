import Anthropic from "@anthropic-ai/sdk";
import { AgentState, GeneratedCode } from "../state.js";
import { GitHubClient } from "../../tools/github.js";
import { buildPrDescriptionPrompt } from "../../prompts/prDescription.js";
import { buildAnalyzeTicketPrompt } from "../../prompts/analyzeTicket.js";
import { addPRToMemory } from "./readMemory.js";
import { getCommenter } from "../../tools/issueCommenter.js";
import { withRetry } from "../../tools/retry.js";

const MODEL     = "claude-haiku-4-5-20251001";
const CODE_MODEL = "claude-sonnet-4-6";
const MAX_PUSH_ATTEMPTS = 3; // total attempts for the write→stage→commit→push cycle

export async function pushToGitHub(state: AgentState): Promise<Partial<AgentState>> {
  const client = new Anthropic();
  const github = new GitHubClient();
  const ticket = state.ticket!;
  let   code   = state.generatedCode!;

  console.log(`\n[pushToGitHub] Creating branch and writing files…`);

  // ── Self-healing write→stage→commit loop ──────────────────────────────────
  // If generated files produce no diff (already in main), regenerate once with a
  // "please make different changes" hint before giving up.

  let branch = "";
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    try {
      branch = await github.createBranchAndWriteFiles(
        `${ticket.number}`,
        ticket.title,
        code.files
      );
      console.log(`[pushToGitHub] ✓ Branch: ${branch} (attempt ${attempt})`);

      await withRetry(
        () => github.commitAndPush(branch, `${ticket.number}`, ticket.title),
        { label: "git commit+push", maxAttempts: 3, baseDelayMs: 2000 }
      );
      console.log(`[pushToGitHub] ✓ Committed and pushed`);

      lastErr = undefined;
      break; // success — exit loop

    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);

      // If the error is "no changes detected", regenerate code with a stronger prompt
      if (msg.includes("No file changes detected") && attempt < MAX_PUSH_ATTEMPTS) {
        console.warn(`[pushToGitHub] ⚠ No diff detected on attempt ${attempt} — regenerating code with diff hint…`);
        code = await regenerateWithDiffHint(client, state, code);
        continue;
      }

      // Transient git/network errors — retry as-is
      if (isGitTransient(msg) && attempt < MAX_PUSH_ATTEMPTS) {
        const delay = 3000 * attempt;
        console.warn(`[pushToGitHub] ⚠ Transient error on attempt ${attempt}: ${msg}. Retrying in ${delay / 1000}s…`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      // Non-recoverable — stop retrying
      throw err;
    }
  }

  if (lastErr) throw lastErr;

  // ── Generate PR description ───────────────────────────────────────────────
  console.log(`[pushToGitHub] Generating PR description…`);
  const prPrompt = buildPrDescriptionPrompt(ticket, code);

  const prResponse = await withRetry(
    () => client.messages.create({
      model:      MODEL,
      max_tokens: 1024,
      messages:   [{ role: "user", content: prPrompt }],
    }),
    { label: "PR description generation", baseDelayMs: 2000 }
  );

  const prBody =
    prResponse.content[0].type === "text"
      ? prResponse.content[0].text
      : `Implements #${ticket.number}: ${ticket.title}`;

  const prTitle = `feat(#${ticket.number}): ${ticket.title}`;

  // ── Create PR (with "already exists" self-healing) ────────────────────────
  const pullRequest = await withRetry(
    () => github.createPullRequest(branch, prTitle, prBody),
    { label: "create PR", maxAttempts: 3, baseDelayMs: 2000 }
  );
  console.log(`[pushToGitHub] ✓ PR created: ${pullRequest.url}`);

  // ── Post PR comment on issue ───────────────────────────────────────────────
  await getCommenter(ticket.number).prCreated(pullRequest.number, pullRequest.url).catch(
    (e: unknown) => console.warn("[pushToGitHub] PR comment failed (non-fatal):", e)
  );

  // ── Add PR to memory index ─────────────────────────────────────────────────
  await addPRToMemory({
    type:         "pr",
    number:       pullRequest.number,
    title:        prTitle,
    summary:      prBody.slice(0, 800),
    filesChanged: code.files.map((f) => f.path),
    url:          pullRequest.url,
  }).catch((e: unknown) => console.warn("[pushToGitHub] Memory index failed (non-fatal):", e));

  return {
    pullRequest,
    currentStep: "pushToGitHub",
    logs: [`Branch: ${branch}`, `PR #${pullRequest.number}: ${pullRequest.url}`],
  };
}

// ── Regenerate code when the diff is empty ────────────────────────────────────

async function regenerateWithDiffHint(
  client: Anthropic,
  state:  AgentState,
  prev:   GeneratedCode
): Promise<GeneratedCode> {
  const ticket = state.ticket!;

  const basePrompt = buildAnalyzeTicketPrompt(
    ticket,
    state.notionContext,
    state.classification!,
    state.repoContext,
    state.projectConfig,
    state.memoryContext
  );

  const hint =
    `\n\nIMPORTANT: The previous code generation produced files that are IDENTICAL to what is already in the repository. ` +
    `This means the feature may already be partially implemented. ` +
    `Your task is to look carefully at what is MISSING or DIFFERENT and implement ONLY the new/changed parts. ` +
    `Previously generated files: ${prev.files.map((f) => f.path).join(", ")}. ` +
    `Make sure your output contains REAL changes that differ from the current codebase.`;

  const response = await withRetry(
    () => client.messages.create({
      model:      CODE_MODEL,
      max_tokens: 16000,
      messages:   [{ role: "user", content: basePrompt + hint }],
    }),
    { label: "code regeneration", baseDelayMs: 3000 }
  );

  const rawText = response.content[0].type === "text" ? response.content[0].text : "";

  try {
    const stripped = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    for (const candidate of [stripped, rawText]) {
      try { return JSON.parse(candidate) as GeneratedCode; } catch { /* try next */ }
      const match = candidate.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]) as GeneratedCode; } catch { /* fall through */ }
      }
    }
  } catch { /* fall through */ }

  console.warn("[pushToGitHub] Regeneration produced unparseable JSON — using previous code");
  return prev;
}

function isGitTransient(msg: string): boolean {
  return /ECONNRESET|ETIMEDOUT|network|timeout|unable to connect|remote.*hung up/i.test(msg);
}
