import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import { AgentState, IssueClassification } from "../state.js";

const MODEL = "claude-haiku-4-5";

/** Recursively collect all source file paths in the repo (excluding noise). */
function collectRepoFiles(repoPath: string): string[] {
  const ignored = new Set([
    "node_modules", ".git", ".mvn", "target", "build", "dist",
    ".idea", ".vscode", "__pycache__", ".DS_Store",
  ]);
  const sourceExts = new Set([
    // JVM
    ".java", ".kt", ".groovy", ".xml", ".properties",
    // Web / Node / React Native
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".css", ".scss", ".sass", ".less",
    ".html", ".htm", ".svg", ".mdx",
    // Config / build
    ".json", ".yml", ".yaml", ".toml", ".env", ".gradle", ".kts",
    // Python
    ".py", ".pyi",
    // Other
    ".go", ".rb", ".cs", ".swift", ".dart",
  ]);

  const results: string[] = [];

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (sourceExts.has(path.extname(entry.name).toLowerCase())) {
        results.push(path.relative(repoPath, fullPath));
      }
    }
  }

  walk(repoPath);
  return results;
}

/** Return the build/config files most relevant to a given language stack. */
function getBuildFiles(allFiles: string[], language: string): string[] {
  const lang = language.toLowerCase();

  const patterns: Record<string, RegExp[]> = {
    java:          [/pom\.xml$/, /build\.gradle/, /application\.(yml|yaml|properties)$/],
    kotlin:        [/build\.gradle/, /application\.(yml|yaml|properties)$/],
    python:        [/requirements.*\.txt$/, /pyproject\.toml$/, /setup\.py$/, /Pipfile$/],
    typescript:    [/package\.json$/, /tsconfig\.json$/, /\.env/],
    javascript:    [/package\.json$/, /\.env/],
    "react-native":[/package\.json$/, /app\.json$/, /tsconfig\.json$/],
    react:         [/package\.json$/, /tsconfig\.json$/],
    node:          [/package\.json$/, /tsconfig\.json$/, /\.env/],
    go:            [/go\.mod$/, /go\.sum$/],
    ruby:          [/Gemfile$/],
    csharp:        [/\.csproj$/, /appsettings\.json$/],
  };

  // Find the best matching pattern list
  const patternList = patterns[lang] ?? patterns["typescript"];

  const matched = allFiles.filter(f => patternList.some(re => re.test(f)));
  return matched.slice(0, 5);
}

export async function classifyIssue(state: AgentState): Promise<Partial<AgentState>> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const ticket = state.ticket!;
  const repoPath = process.env.LOCAL_REPO_PATH!;
  const projectConfig = state.projectConfig;
  const language = projectConfig?.language ?? "unknown";

  console.log(`\n[classifyIssue] Scanning repo and classifying issue #${ticket.number}...`);

  // Collect all files in the repo
  const allFiles = collectRepoFiles(repoPath);
  console.log(`[classifyIssue] Found ${allFiles.length} source files in repo`);

  const fileList = allFiles.join("\n");

  // Build a project context hint for Claude
  const projectHint = projectConfig
    ? `Language: ${projectConfig.language}${projectConfig.framework ? ` / ${projectConfig.framework}` : ""}${projectConfig.build_tool ? ` (${projectConfig.build_tool})` : ""}`
    : "Unknown stack — infer from file extensions";

  const prompt = `You are a senior software engineer helping to classify a GitHub issue.

## Project Stack
${projectHint}

## GitHub Issue
Title: ${ticket.title}
Body: ${ticket.body || "(no description provided)"}
Labels: ${ticket.labels.join(", ") || "none"}

## Existing Repository Files
${fileList}

## Your Task
Analyze the issue and the existing files to determine:

1. **type**: Is this a FRESH feature (brand new code, no existing files to modify) or a MODIFICATION (changing/extending existing code)?
   - "fresh" = new endpoint, new component, new module, new service that doesn't exist yet
   - "modification" = adding validation, fixing a bug, updating logic in existing files

2. **relevantFilePaths**: List the EXACT file paths from the repo file list above that are most relevant to this issue.
   - For modifications: list the files that NEED to be changed
   - For fresh: list files that show the patterns/conventions to follow (e.g., similar controllers, package.json, pom.xml, requirements.txt)
   - Max 10 files

3. **keywords**: 2-5 keywords extracted from the issue that describe what's being built/changed

4. **reason**: One sentence explaining your classification decision

Respond ONLY with valid JSON, no markdown fences:
{
  "type": "fresh" | "modification",
  "reason": "...",
  "relevantFilePaths": ["path/to/File.ts", ...],
  "keywords": ["keyword1", "keyword2", ...]
}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.content[0].type === "text" ? response.content[0].text : "{}";

  let classification: IssueClassification;
  try {
    const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    classification = JSON.parse(stripped) as IssueClassification;
  } catch {
    console.warn("[classifyIssue] ⚠ Could not parse classification, defaulting to fresh");
    classification = {
      type: "fresh",
      reason: "Could not classify — defaulting to fresh development",
      relevantFilePaths: getBuildFiles(allFiles, language),
      keywords: ticket.title.split(" ").slice(0, 3),
    };
  }

  console.log(`[classifyIssue] ✓ Type: ${classification.type.toUpperCase()} — ${classification.reason}`);
  console.log(`[classifyIssue] ✓ Relevant files (${classification.relevantFilePaths.length}):`);
  classification.relevantFilePaths.forEach(f => console.log(`  - ${f}`));

  return {
    classification,
    currentStep: "classifyIssue",
    logs: [`Issue classified as: ${classification.type} — ${classification.reason}`],
  };
}
