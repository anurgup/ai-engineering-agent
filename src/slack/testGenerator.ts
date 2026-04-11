/**
 * AI-generated test cases for a GitHub issue.
 * Uses Claude Haiku + fetches issue context from GitHub.
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export async function generateTestCases(
  issueNumber: number,
  title:       string
): Promise<string> {
  // Fetch issue body from GitHub for more context
  const owner = process.env.GITHUB_OWNER;
  const repo  = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;

  let issueBody = "";
  if (owner && repo && token) {
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
        { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" } }
      );
      if (resp.ok) {
        const data = await resp.json() as { body?: string };
        issueBody = data.body ?? "";
      }
    } catch {
      // proceed without issue body
    }
  }

  const msg = await client.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 800,
    system:
      `You are a QA engineer. Generate practical test cases for a software feature.
Format as a numbered list with:
- Test case name
- Steps
- Expected result
Keep it concise — max 5 test cases.`,
    messages: [
      {
        role:    "user",
        content: `Generate test cases for:\n\nTitle: ${title}\n\n${issueBody ? `Description:\n${issueBody}` : ""}`,
      },
    ],
  });

  const block = msg.content[0];
  return block.type === "text" ? block.text : "Could not generate test cases.";
}
