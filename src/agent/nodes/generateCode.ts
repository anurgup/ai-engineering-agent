import Anthropic from "@anthropic-ai/sdk";
import { AgentState, GeneratedCode } from "../state.js";
import { buildAnalyzeTicketPrompt } from "../../prompts/analyzeTicket.js";

const MODEL = "claude-sonnet-4-6";

function extractJson(text: string): GeneratedCode {
  // Strip markdown code fences if present (```json ... ``` or ``` ... ```)
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

  // First try direct parse on stripped text
  for (const candidate of [stripped, text]) {
    try {
      return JSON.parse(candidate) as GeneratedCode;
    } catch {
      // Try to extract the outermost JSON object
      const match = candidate.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]) as GeneratedCode;
        } catch {
          // fall through
        }
      }
    }
  }
  throw new Error(`Failed to parse Claude response as JSON.\n\nRaw response:\n${text.slice(0, 500)}`);
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

async function callClaudeWithRetry(client: Anthropic, prompt: string): Promise<Anthropic.Message> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await client.messages.create({
        model: MODEL,
        max_tokens: 16000,
        messages: [{ role: "user", content: prompt }],
      });
    } catch (err) {
      const isLast = attempt === MAX_RETRIES;
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isLast) throw err;
      const cause = (err as NodeJS.ErrnoException)?.cause;
      const causeMsg = cause instanceof Error ? ` | cause: ${cause.message} (${(cause as NodeJS.ErrnoException).code})` : "";
      console.warn(`[generateCode] ⚠ Attempt ${attempt} failed (${errMsg}${causeMsg}). Retrying in ${RETRY_DELAY_MS / 1000}s...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  throw new Error("Unreachable");
}

export async function generateCode(state: AgentState): Promise<Partial<AgentState>> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const ticket = state.ticket!;

  console.log(`\n[generateCode] Sending ticket to Claude ${MODEL}...`);
  const prompt = buildAnalyzeTicketPrompt(ticket, state.notionContext, state.classification!, state.repoContext, state.projectConfig, state.memoryContext);

  const response = await callClaudeWithRetry(client, prompt);

  const rawText =
    response.content[0].type === "text" ? response.content[0].text : "";

  const generatedCode = extractJson(rawText);

  console.log(
    `[generateCode] ✓ Generated ${generatedCode.files.length} file(s):`
  );
  generatedCode.files.forEach((f) => console.log(`  - ${f.path}`));

  if (generatedCode.dependencies.length > 0) {
    console.log(
      `[generateCode] New dependencies: ${generatedCode.dependencies.join(", ")}`
    );
  }

  return {
    generatedCode,
    currentStep: "generateCode",
    logs: [
      `Code generation complete: ${generatedCode.files.length} files`,
      `Summary: ${generatedCode.summary}`,
    ],
  };
}
