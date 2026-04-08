import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { AgentState, ProjectConfig } from "../state.js";

const CONFIG_FILE = "project.yml";

/** Minimal YAML parser — handles simple key: value and list items (- item). */
function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.trimStart().startsWith("#")) continue;

    // List item under current key:  "  - value"
    if (line.match(/^\s+-\s+/) && currentKey) {
      const value = line.replace(/^\s+-\s+/, "").trim();
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      (result[currentKey] as string[]).push(value);
      continue;
    }

    // Key: value pair
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (value) {
      result[key] = value;
      currentKey = key;
    } else {
      // key with no inline value → next lines are list items
      result[key] = [];
      currentKey = key;
    }
  }

  return result;
}

/** Clone the repo locally if LOCAL_REPO_PATH doesn't exist. */
function ensureRepoCloned(repoPath: string): void {
  if (fs.existsSync(repoPath)) return;

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo  = process.env.GITHUB_REPO;

  if (!token || !owner || !repo) {
    throw new Error(
      `Repo not found at ${repoPath} and cannot auto-clone: missing GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO`
    );
  }

  const cloneUrl = `https://${token}@github.com/${owner}/${repo}.git`;
  const parentDir = path.dirname(repoPath);

  console.log(`[readProjectConfig] Repo not found locally — cloning ${owner}/${repo}...`);
  fs.mkdirSync(parentDir, { recursive: true });
  execSync(`git clone ${cloneUrl} ${repoPath}`, { stdio: "pipe" });
  console.log(`[readProjectConfig] ✓ Cloned to ${repoPath}`);
}

export async function readProjectConfig(state: AgentState): Promise<Partial<AgentState>> {
  const repoPath = process.env.LOCAL_REPO_PATH!;

  console.log(`\n[readProjectConfig] Checking repo at: ${repoPath}`);

  // Auto-clone if repo doesn't exist locally
  try {
    ensureRepoCloned(repoPath);
  } catch (err) {
    console.error(`[readProjectConfig] ✗ ${(err as Error).message}`);
    throw err;
  }

  // Look for project.yml in repo root
  const configPath = path.join(repoPath, CONFIG_FILE);

  if (!fs.existsSync(configPath)) {
    console.warn(
      `[readProjectConfig] ⚠ No ${CONFIG_FILE} found in repo root — agent will infer language from existing files`
    );
    return {
      projectConfig: undefined,
      currentStep: "readProjectConfig",
      logs: [`No ${CONFIG_FILE} found — language will be inferred from repo files`],
    };
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = parseSimpleYaml(raw);

  const projectConfig: ProjectConfig = {
    language:      (parsed.language      as string) ?? "unknown",
    framework:      parsed.framework      as string | undefined,
    build_tool:     parsed.build_tool     as string | undefined,
    test_framework: parsed.test_framework as string | undefined,
    database:       parsed.database       as string | undefined,
    package_manager: parsed.package_manager as string | undefined,
    conventions:   (parsed.conventions   as string[] | undefined) ?? [],
    extra: Object.fromEntries(
      Object.entries(parsed).filter(([k]) =>
        !["language","framework","build_tool","test_framework",
          "database","package_manager","conventions"].includes(k)
      )
    ),
  };

  console.log(`[readProjectConfig] ✓ Language: ${projectConfig.language}`);
  if (projectConfig.framework)   console.log(`[readProjectConfig] ✓ Framework: ${projectConfig.framework}`);
  if (projectConfig.build_tool)  console.log(`[readProjectConfig] ✓ Build tool: ${projectConfig.build_tool}`);
  if (projectConfig.database)    console.log(`[readProjectConfig] ✓ Database: ${projectConfig.database}`);
  if (projectConfig.conventions?.length)
    console.log(`[readProjectConfig] ✓ Conventions: ${projectConfig.conventions.length} rules`);

  return {
    projectConfig,
    currentStep: "readProjectConfig",
    logs: [
      `Project: ${projectConfig.language} / ${projectConfig.framework ?? "no framework"} / ${projectConfig.build_tool ?? "no build tool"}`,
    ],
  };
}
