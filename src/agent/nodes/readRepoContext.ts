import * as fs from "fs";
import * as path from "path";
import { AgentState, RepoFile } from "../state.js";
import { getCommenter } from "../../tools/issueCommenter.js";

const MAX_FILE_CHARS  = 8000;    // truncate very large files
const MAX_TOTAL_CHARS = 40000;   // cap total context sent to Claude

// ── Endpoint / method skeleton extraction ────────────────────────────────────
// For controller & service files we prepend a compact "API surface" block so
// Claude always knows what methods/endpoints exist even in large files.

const CONTROLLER_RE = /Controller\.(java|kt)$/i;
const SERVICE_RE    = /Service(Impl)?\.(java|kt)$/i;

/**
 * Extract a compact method-signature list from Java/Kotlin source.
 * Returns empty string for non-JVM files.
 */
function extractMethodSkeleton(filePath: string, content: string): string {
  if (!/\.(java|kt)$/i.test(filePath)) return "";

  const lines: string[] = [];

  // Capture Spring HTTP mapping annotations + the method signature on the next non-blank line
  const mappingRe = /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*(?:\([^)]*\))?/;

  const contentLines = content.split("\n");
  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i].trim();
    if (mappingRe.test(line)) {
      // Grab the annotation line + the method line
      lines.push("  " + line);
      // Skip blank lines to find the method declaration
      let j = i + 1;
      while (j < contentLines.length && contentLines[j].trim() === "") j++;
      if (j < contentLines.length) {
        const methodLine = contentLines[j].trim().replace(/\{.*$/, "{...}");
        lines.push("  " + methodLine);
      }
    }
    // Also capture plain public method signatures for service files
    else if (SERVICE_RE.test(filePath) && /^\s*public\s+/.test(contentLines[i])) {
      const sig = contentLines[i].trim().replace(/\{.*$/, "{...}").replace(/^\s*@\w+.*/, "");
      if (sig && !sig.startsWith("//") && sig.length < 120) {
        lines.push("  " + sig);
      }
    }
  }

  return lines.length > 0
    ? `\n// ── Existing methods in this file ──────────────────────────\n${lines.join("\n")}\n// ────────────────────────────────────────────────────────────\n`
    : "";
}

export async function readRepoContext(state: AgentState): Promise<Partial<AgentState>> {
  const repoPath = process.env.LOCAL_REPO_PATH!;
  const classification = state.classification!;

  console.log(`\n[readRepoContext] Reading ${classification.relevantFilePaths.length} relevant file(s) from repo...`);

  const repoFiles: RepoFile[] = [];
  let totalChars = 0;

  for (const relPath of classification.relevantFilePaths) {
    if (totalChars >= MAX_TOTAL_CHARS) {
      console.log(`[readRepoContext] ⚠ Total context limit reached — skipping remaining files`);
      break;
    }

    const absPath = path.join(repoPath, relPath);
    try {
      let content = fs.readFileSync(absPath, "utf-8");

      // For controller / service files inject a compact method skeleton BEFORE
      // the full content so Claude sees the API surface immediately.
      const isArchFile = CONTROLLER_RE.test(relPath) || SERVICE_RE.test(relPath);
      let displayContent = content;

      if (isArchFile) {
        const skeleton = extractMethodSkeleton(relPath, content);
        if (skeleton) {
          displayContent = skeleton + "\n" + content;
        }
      }

      // Truncate overly large files
      if (displayContent.length > MAX_FILE_CHARS) {
        displayContent = displayContent.slice(0, MAX_FILE_CHARS) + "\n... [truncated]";
      }

      repoFiles.push({ path: relPath, content: displayContent });
      totalChars += displayContent.length;
      console.log(`  ✓ ${relPath} (${displayContent.length} chars${isArchFile ? " — with method skeleton" : ""})`);
    } catch {
      console.warn(`  ⚠ Could not read: ${relPath}`);
    }
  }

  console.log(`[readRepoContext] ✓ Loaded ${repoFiles.length} file(s) — ${totalChars.toLocaleString()} total chars`);

  // Post progress comment
  const issueNumber = state.ticket!.number;
  await getCommenter(issueNumber).readingFiles(
    repoFiles.length,
    repoFiles.map((f) => f.path)
  );

  return {
    repoContext: repoFiles,
    currentStep: "readRepoContext",
    logs: [`Loaded ${repoFiles.length} repo files as context (${totalChars} chars)`],
  };
}
