import { GitHubIssue, GeneratedCode } from "../agent/state.js";

export function buildPrDescriptionPrompt(
  ticket: GitHubIssue,
  generatedCode: GeneratedCode
): string {
  const fileList = generatedCode.files
    .map((f) => `- \`${f.path}\``)
    .join("\n");

  const deps =
    generatedCode.dependencies.length > 0
      ? generatedCode.dependencies.join(", ")
      : "None";

  return `You are a software engineer writing a GitHub Pull Request description.

## GitHub Issue
Number: #${ticket.number}
Title: ${ticket.title}
URL: ${ticket.url}
Description: ${ticket.body}

## Implementation Summary
${generatedCode.summary}

## Files Changed
${fileList}

## New Dependencies
${deps}

## Test Instructions
${generatedCode.testInstructions}

Write a concise, professional GitHub PR description in Markdown. Use this exact structure:

## Summary
[2-3 bullet points describing what this PR does]

## Changes
[List of files changed with brief descriptions]

## Testing
[How to test this change]

## Issue
Closes #${ticket.number}: ${ticket.title}

Keep it factual and brief. No fluff.`;
}
