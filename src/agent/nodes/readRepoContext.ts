import * as fs from "fs";
import * as path from "path";
import { AgentState, RepoFile } from "../state.js";

const MAX_FILE_CHARS = 8000;   // truncate very large files
const MAX_TOTAL_CHARS = 40000; // cap total context sent to Claude

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

      // Truncate overly large files
      if (content.length > MAX_FILE_CHARS) {
        content = content.slice(0, MAX_FILE_CHARS) + "\n... [truncated]";
      }

      repoFiles.push({ path: relPath, content });
      totalChars += content.length;
      console.log(`  ✓ ${relPath} (${content.length} chars)`);
    } catch {
      console.warn(`  ⚠ Could not read: ${relPath}`);
    }
  }

  console.log(`[readRepoContext] ✓ Loaded ${repoFiles.length} file(s) — ${totalChars.toLocaleString()} total chars`);

  return {
    repoContext: repoFiles,
    currentStep: "readRepoContext",
    logs: [`Loaded ${repoFiles.length} repo files as context (${totalChars} chars)`],
  };
}
