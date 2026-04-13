import { GitHubIssue, GeneratedCode, PullRequest } from "../agent/state.js";

export function buildNotionDocPrompt(
  ticket: GitHubIssue,
  generatedCode: GeneratedCode,
  pullRequest: PullRequest
): string {
  const fileList = generatedCode.files.map((f) => `- \`${f.path}\``).join("\n");
  const deps = generatedCode.dependencies.length > 0
    ? generatedCode.dependencies.join(", ")
    : "None";

  return `You are a technical writer updating Notion documentation for a feature.
Be concise — every section should be 2-4 lines max. No fluff.

## Input
- Issue: #${ticket.number} — ${ticket.title}
- PR: ${pullRequest.url}
- Summary: ${generatedCode.summary}
- Files changed:\n${fileList}
- Dependencies: ${deps}
- Test instructions: ${generatedCode.testInstructions}

## Output Format (Markdown only, no code fences wrapping the whole response)

# #${ticket.number}: ${ticket.title}

> 📌 **Status:** In Review &nbsp;|&nbsp; 🔗 [GitHub Issue](${ticket.url}) &nbsp;|&nbsp; 🔀 [Pull Request](${pullRequest.url})

---

## 🎯 What & Why
[One sentence: what the feature does and why it was needed]

## 📁 Files Changed
${fileList}

## ⚙️ How It Works
[2-3 bullet points on the key implementation details — classes, methods, flow]

## 🧪 How to Test
[Numbered steps — be specific with curl commands or UI steps]

## 📦 Dependencies
${deps}

---
_Last updated by AI agent_

Return ONLY the Markdown — no preamble.`;
}
