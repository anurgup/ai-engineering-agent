import Anthropic from "@anthropic-ai/sdk";
import { AgentState, ProjectConfig } from "../state.js";

const MODEL = "claude-haiku-4-5-20251001";

/**
 * If no project.yml was found, try to infer the tech stack from the
 * GitHub issue body and any Notion documentation already fetched.
 * Runs after readNotion so both sources are available.
 */
export async function inferProjectConfig(state: AgentState): Promise<Partial<AgentState>> {

  // Already set by project.yml — nothing to do
  if (state.projectConfig) {
    console.log(`\n[inferProjectConfig] project.yml already loaded (${state.projectConfig.language}) — skipping inference`);
    return {};
  }

  const ticket = state.ticket!;
  console.log(`\n[inferProjectConfig] No project.yml — inferring stack from ticket + Notion...`);

  // --- Gather all available text ---
  const ticketText = [
    `Title: ${ticket.title}`,
    `Labels: ${ticket.labels.join(", ") || "none"}`,
    `Body:\n${ticket.body || "(no body)"}`,
  ].join("\n");

  const notionText =
    state.notionContext.length > 0
      ? state.notionContext
          .map((p) => `[Notion: ${p.title}]\n${p.excerpt}`)
          .join("\n\n")
      : "(no Notion pages found)";

  const prompt = `You are a tech stack detector. Analyze the text below and identify the programming language and framework being used or requested.

## GitHub Issue
${ticketText}

## Notion Documentation
${notionText}

## Your Task
Extract the tech stack from the text above.

Rules:
- Look for explicit mentions: "Python", "FastAPI", "React Native", "Node.js", "Spring Boot", "Express", "Django", "Next.js", etc.
- Also infer from context: "REST API with async endpoints" → likely Python/FastAPI or Node.js; "mobile app screens" → likely React Native
- For language: use lowercase — "java", "python", "typescript", "javascript", "kotlin", "go", "ruby"
- For react-native specifically use: "react-native" (with hyphen)
- If genuinely unknown, use "unknown"

Respond ONLY with valid JSON, no markdown:
{
  "language": "python",
  "framework": "fastapi",
  "build_tool": "pip",
  "test_framework": "pytest",
  "database": "postgresql",
  "package_manager": "pip",
  "confidence": "high" | "medium" | "low",
  "reason": "one sentence explaining what clues you used"
}

Only include fields you are reasonably confident about. Use null for fields you cannot determine.`;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let raw = "{}";
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });
    raw = response.content[0].type === "text" ? response.content[0].text : "{}";
  } catch (err) {
    console.warn(`[inferProjectConfig] ⚠ Claude call failed — ${(err as Error).message}`);
    return {
      currentStep: "inferProjectConfig",
      logs: ["Stack inference failed — will infer from repo files"],
    };
  }

  // Parse response
  let inferred: Record<string, unknown> = {};
  try {
    const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    inferred = JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    console.warn("[inferProjectConfig] ⚠ Could not parse inference response — leaving projectConfig undefined");
    return {
      currentStep: "inferProjectConfig",
      logs: ["Stack inference parse failed — will infer from repo files"],
    };
  }

  const confidence = inferred.confidence as string ?? "low";
  const reason     = inferred.reason     as string ?? "";
  const language   = inferred.language   as string ?? "unknown";

  if (language === "unknown" || confidence === "low") {
    console.log(`[inferProjectConfig] ⚠ Low confidence inference (${confidence}) — leaving projectConfig undefined`);
    console.log(`[inferProjectConfig]   Reason: ${reason}`);
    return {
      currentStep: "inferProjectConfig",
      logs: [`Stack inference low confidence (${confidence}) — will infer from repo files`],
    };
  }

  // Build ProjectConfig from inference — skip null values
  const projectConfig: ProjectConfig = {
    language,
    framework:       (inferred.framework       as string) || undefined,
    build_tool:      (inferred.build_tool       as string) || undefined,
    test_framework:  (inferred.test_framework   as string) || undefined,
    database:        (inferred.database         as string) || undefined,
    package_manager: (inferred.package_manager  as string) || undefined,
    conventions:     [],  // can't infer conventions — user should add project.yml for those
    extra:           {},
  };

  console.log(`[inferProjectConfig] ✓ Inferred stack (${confidence} confidence):`);
  console.log(`  Language:  ${projectConfig.language}`);
  if (projectConfig.framework)    console.log(`  Framework: ${projectConfig.framework}`);
  if (projectConfig.build_tool)   console.log(`  Build:     ${projectConfig.build_tool}`);
  if (projectConfig.database)     console.log(`  Database:  ${projectConfig.database}`);
  console.log(`  Reason:    ${reason}`);
  console.log(`\n  💡 Tip: Add a project.yml to your repo root for conventions & full control.`);

  return {
    projectConfig,
    currentStep: "inferProjectConfig",
    logs: [
      `Stack inferred from ticket/Notion (${confidence}): ${language}/${projectConfig.framework ?? "no framework"}`,
      `Reason: ${reason}`,
    ],
  };
}
