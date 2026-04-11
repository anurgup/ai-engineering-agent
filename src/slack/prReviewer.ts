/**
 * AI PR Reviewer.
 * Fetches the PR diff from GitHub and asks Claude to review it.
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export async function reviewPR(
  prNumber:    number,
  issueNumber: number,
  title:       string
): Promise<string> {
  const owner = process.env.GITHUB_OWNER;
  const repo  = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;

  if (!owner || !repo || !token) {
    return "GitHub not configured — cannot review PR.";
  }

  // Fetch PR diff
  let diff = "";
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept:        "application/vnd.github.v3.diff",
        },
      }
    );
    if (resp.ok) {
      diff = await resp.text();
      // Truncate to 3000 chars to keep tokens low
      if (diff.length > 3000) diff = diff.slice(0, 3000) + "\n... (truncated)";
    }
  } catch {
    diff = "(could not fetch diff)";
  }

  const msg = await client.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 600,
    system:
      `You are a senior software engineer doing a code review.
Be concise. Check for:
1. Correctness — does it solve the issue?
2. Security — any obvious vulnerabilities?
3. Performance — any inefficiencies?
4. Code quality — naming, structure, edge cases
Format: short bullet points. End with LGTM ✅ or NEEDS CHANGES ⚠️`,
    messages: [
      {
        role:    "user",
        content: `Review PR #${prNumber} for issue #${issueNumber}: ${title}\n\nDiff:\n${diff}`,
      },
    ],
  });

  const block = msg.content[0];
  return block.type === "text" ? block.text : "Could not generate review.";
}
