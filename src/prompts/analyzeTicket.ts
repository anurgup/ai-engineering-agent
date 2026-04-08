import { GitHubIssue, NotionPage, IssueClassification, RepoFile, ProjectConfig, MemoryEntry } from "../agent/state.js";

export function buildAnalyzeTicketPrompt(
  ticket: GitHubIssue,
  notionContext: NotionPage[],
  classification: IssueClassification,
  repoContext: RepoFile[],
  projectConfig?: ProjectConfig,
  memoryContext: MemoryEntry[] = []
): string {

  // --- Project config section ---
  const projectSection = projectConfig
    ? [
        `Language: ${projectConfig.language}`,
        projectConfig.framework     ? `Framework: ${projectConfig.framework}`           : null,
        projectConfig.build_tool    ? `Build Tool: ${projectConfig.build_tool}`         : null,
        projectConfig.test_framework? `Test Framework: ${projectConfig.test_framework}` : null,
        projectConfig.database      ? `Database: ${projectConfig.database}`             : null,
        projectConfig.package_manager? `Package Manager: ${projectConfig.package_manager}` : null,
        projectConfig.conventions?.length
          ? `Conventions:\n${projectConfig.conventions.map(c => `  - ${c}`).join("\n")}`
          : null,
      ].filter(Boolean).join("\n")
    : "No project.yml found — infer language and conventions from existing code.";

  // --- Memory context section (past PRs + issues) ---
  const memorySection =
    memoryContext.length > 0
      ? memoryContext.map((e) => {
          const lines = [
            `[${e.type.toUpperCase()} #${e.number}] ${e.title}`,
            e.summary ? `Summary: ${e.summary}` : null,
            e.filesChanged.length > 0
              ? `Files changed: ${e.filesChanged.join(", ")}`
              : null,
            `URL: ${e.url}`,
          ];
          return lines.filter(Boolean).join("\n");
        }).join("\n\n")
      : "No relevant past work found.";

  // --- Notion context section ---
  const notionSection =
    notionContext.length > 0
      ? notionContext
          .map((p, i) => `--- Notion Page ${i + 1}: ${p.title} (${p.url}) ---\n${p.excerpt}`)
          .join("\n\n")
      : "No Notion documentation available.";

  // --- Repo context section ---
  const repoSection =
    repoContext.length > 0
      ? repoContext
          .map(f => `=== FILE: ${f.path} ===\n${f.content}`)
          .join("\n\n")
      : "No existing repo files available.";

  // --- Language-specific output hints ---
  const lang = projectConfig?.language?.toLowerCase() ?? "unknown";

  const dependencyFormat =
    lang === "java" || lang === "kotlin"
      ? `"groupId:artifactId:version"  (Maven format, e.g. "org.springframework.boot:spring-boot-starter-security:3.2.0")`
      : lang === "python"
      ? `"package-name==version"  (pip format, e.g. "fastapi==0.110.0", "sqlalchemy==2.0.0")`
      : lang === "react-native" || lang === "react" || lang === "javascript" || lang === "typescript" || lang === "node"
      ? `"package-name@version"  (npm format, e.g. "axios@1.6.0", "express@4.18.0")`
      : `"package@version" or "group:artifact:version" depending on the language`;

  const pathExample =
    lang === "java" || lang === "kotlin"
      ? `"src/main/java/com/example/app/controller/UserController.java"`
      : lang === "python"
      ? `"app/routers/users.py"`
      : lang === "react-native"
      ? `"src/screens/HomeScreen.tsx"`
      : lang === "react"
      ? `"src/components/UserCard.tsx"`
      : lang === "node" || lang === "typescript" || lang === "javascript"
      ? `"src/routes/users.ts"`
      : `"src/path/to/file"`;

  // --- Mode-specific instructions ---
  const isFresh = classification.type === "fresh";

  // --- Language-specific generation notes ---
  const langNotes: Record<string, string> = {
    java: `- Use Spring annotations correctly (@RestController, @Service, @Repository, @Autowired etc.)
- Place files in the correct Maven source directory (src/main/java/...)
- Add tests under src/test/java/...`,
    kotlin: `- Use Kotlin idioms (data classes, extension functions, coroutines where appropriate)
- Place files in src/main/kotlin/...`,
    python: `- Follow PEP 8 style
- Use type hints on all function signatures
- Async functions for FastAPI/async frameworks; sync for Flask/Django
- Place tests in tests/ directory`,
    "react-native": `- Use functional components with hooks (useState, useEffect, useCallback)
- TypeScript interfaces for all props
- Use StyleSheet.create() for styles — no inline style objects
- Navigation via React Navigation (useNavigation, useRoute)
- Platform-specific code via Platform.select() or .ios.tsx / .android.tsx files`,
    react: `- Functional components with hooks only — no class components
- TypeScript props interfaces above each component
- CSS Modules or styled-components depending on existing patterns`,
    typescript: `- Strict TypeScript — no 'any' types
- Export types/interfaces alongside implementations`,
    javascript: `- Use ES modules (import/export)
- Add JSDoc comments for public functions`,
    node: `- Async/await throughout — no raw callbacks
- Proper error handling with try/catch and Express error middleware
- Environment variables via process.env, never hardcoded`,
  };

  const langSpecific = langNotes[lang] ?? "";
  const langSection = langSpecific
    ? `## Language-Specific Rules (${projectConfig?.language ?? "inferred"})
${langSpecific}`
    : "";

  const modeInstructions = isFresh
    ? `## Development Mode: FRESH FEATURE
This is brand new functionality. No existing files cover this feature.
- Create all required new files from scratch
- Follow the EXACT same package structure, naming conventions, and patterns shown in the existing repo files above
- Reuse the same dependencies already in the build file (package.json / pom.xml / requirements.txt)
- Do NOT recreate files that already exist unless they need to be modified

${langSection}`

    : `## Development Mode: MODIFICATION
This issue requires MODIFYING existing code, NOT creating new files.
- You MUST edit the existing files shown above — do not invent new ones unless absolutely necessary
- Preserve ALL existing logic — only add/change what the issue asks for
- Keep the same class names, method signatures, package names, and patterns
- If a file needs changes, return the COMPLETE updated file content (not a diff)
- Pay close attention to the existing implementation and integrate cleanly

${langSection}`;

  return `You are a senior software engineer working on an existing codebase. Your task is to implement a GitHub Issue.

## Project Configuration
${projectSection}

## GitHub Issue
Number: #${ticket.number}
Title: ${ticket.title}
URL: ${ticket.url}
Labels: ${ticket.labels.join(", ") || "None"}

Description:
${ticket.body || "(no description provided)"}

## Issue Classification
Type: ${classification.type.toUpperCase()}
Reason: ${classification.reason}
Keywords: ${classification.keywords.join(", ")}

${modeInstructions}

## Past Work (Merged PRs & Closed Issues)
Use this to understand what was already built — never duplicate it.
${memorySection}

## Existing Codebase (Relevant Files)
${repoSection}

## Architecture Documentation (from Notion)
${notionSection}

## Output Instructions
Analyze everything above carefully, then generate your implementation.
Respond ONLY with valid JSON matching this exact structure:

{
  "files": [
    {
      "path": ${pathExample},
      "content": "full file content here"
    }
  ],
  "summary": "One paragraph describing what was implemented and why, mentioning which files were modified vs created",
  "dependencies": [${dependencyFormat}],
  "testInstructions": "Step-by-step instructions for testing the implementation"
}

Rules:
- For MODIFICATION: file paths must match EXACTLY the existing paths shown above
- For FRESH: follow the same directory/package structure as existing code
- Keep file contents concise — no excessive comments or blank lines
- Only list NEW dependencies not already in pom.xml
- Do not wrap your response in markdown fences — return raw JSON only
- IMPORTANT: Your entire response must be valid JSON only — no extra text before or after`;
}
