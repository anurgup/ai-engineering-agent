import { GitHubIssue, GeneratedCode, PullRequest } from "../agent/state.js";

export function buildNotionDocPrompt(
  ticket: GitHubIssue,
  generatedCode: GeneratedCode,
  pullRequest: PullRequest
): string {
  const fileList = generatedCode.files
    .map((f) => `- ${f.path}`)
    .join("\n");

  const deps =
    generatedCode.dependencies.length > 0
      ? generatedCode.dependencies.join(", ")
      : "None";

  return `You are a technical writer creating Notion documentation for a newly implemented feature.

## Feature Details
GitHub Issue: #${ticket.number} — ${ticket.title}
Issue URL: ${ticket.url}
Pull Request: ${pullRequest.url}

## Implementation Summary
${generatedCode.summary}

## Files
${fileList}

## Dependencies Added
${deps}

## Test Instructions
${generatedCode.testInstructions}

Generate a Notion page in Markdown format. The page must be structured so that:
1. A human developer can understand the feature quickly
2. A future AI agent can retrieve this page via semantic search and understand the architecture

Use this exact structure (Markdown only, no HTML):

## Overview
[What this feature does and why it was built]

## Implementation
[Key files, classes, functions, and how they interact]

## Architecture Decisions
[Any non-obvious design choices and the reasoning]

## Dependencies
[New packages and why they were chosen]

## Testing
[How to verify the feature works]

## Links
- GitHub Issue: ${ticket.url}
- Pull Request: ${pullRequest.url}

Return ONLY the Markdown content — no preamble, no code fences wrapping the whole response.`;
}
