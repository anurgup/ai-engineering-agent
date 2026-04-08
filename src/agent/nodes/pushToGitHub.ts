import Anthropic from "@anthropic-ai/sdk";
import { AgentState } from "../state.js";
import { GitHubClient } from "../../tools/github.js";
import { buildPrDescriptionPrompt } from "../../prompts/prDescription.js";
import { addPRToMemory } from "./readMemory.js";

const MODEL = "claude-haiku-4-5-20251001";

export async function pushToGitHub(state: AgentState): Promise<Partial<AgentState>> {
  const client = new Anthropic();
  const github = new GitHubClient();
  const ticket = state.ticket!;
  const code = state.generatedCode!;

  console.log(`\n[pushToGitHub] Creating branch and writing files...`);

  const branch = await github.createBranchAndWriteFiles(
    `${ticket.number}`,
    ticket.title,
    code.files
  );
  console.log(`[pushToGitHub] ✓ Branch: ${branch}`);

  await github.commitAndPush(branch, `${ticket.number}`, ticket.title);
  console.log(`[pushToGitHub] ✓ Committed and pushed`);

  // Generate PR description with Haiku
  console.log(`[pushToGitHub] Generating PR description with Claude Haiku...`);
  const prPrompt = buildPrDescriptionPrompt(ticket, code);

  const prResponse = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [{ role: "user", content: prPrompt }],
  });

  const prBody =
    prResponse.content[0].type === "text"
      ? prResponse.content[0].text
      : `Implements #${ticket.number}: ${ticket.title}`;

  const prTitle = `feat(#${ticket.number}): ${ticket.title}`;

  const pullRequest = await github.createPullRequest(branch, prTitle, prBody);
  console.log(`[pushToGitHub] ✓ PR created: ${pullRequest.url}`);

  // ── Instantly add this PR to the memory index so future tickets find it ────
  await addPRToMemory({
    type:         "pr",
    number:       pullRequest.number,
    title:        prTitle,
    summary:      prBody.slice(0, 800),
    filesChanged: code.files.map((f) => f.path),
    url:          pullRequest.url,
  });

  return {
    pullRequest,
    currentStep: "pushToGitHub",
    logs: [`Branch: ${branch}`, `PR #${pullRequest.number}: ${pullRequest.url}`],
  };
}
