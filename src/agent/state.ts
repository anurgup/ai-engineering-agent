import { Annotation } from "@langchain/langgraph";

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  url: string;
}

export interface NotionPage {
  id: string;
  title: string;
  url: string;
  excerpt: string; // truncated to ~1000 chars
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface GeneratedCode {
  files: GeneratedFile[];
  summary: string;
  dependencies: string[];
  testInstructions: string;
}

export interface PullRequest {
  number: number;
  url: string;
  branch: string;
  title: string;
}

export interface NotionDoc {
  id: string;
  url: string;
  title: string;
}

export interface ProjectConfig {
  language: string;                // e.g. "java", "python", "typescript"
  framework?: string;              // e.g. "spring-boot", "fastapi", "express"
  build_tool?: string;             // e.g. "maven", "gradle", "pip", "npm"
  test_framework?: string;         // e.g. "junit", "pytest", "jest"
  database?: string;               // e.g. "postgresql", "mongodb", "cassandra"
  package_manager?: string;        // e.g. "pip", "npm", "yarn"
  conventions?: string[];          // coding conventions / rules
  extra?: Record<string, unknown>; // any extra fields from project.yml
}

export interface MemoryEntry {
  type:         "pr" | "issue";
  number:       number;
  title:        string;
  summary:      string;      // PR body / issue body (truncated)
  filesChanged: string[];    // files touched in the PR
  url:          string;
}

export type IssueType = "fresh" | "modification";

export interface RepoFile {
  path: string;       // relative path from repo root
  content: string;    // full file content
}

export interface IssueClassification {
  type: IssueType;
  reason: string;                // short explanation
  relevantFilePaths: string[];   // existing files to read
  keywords: string[];            // extracted search terms
}

// LangGraph Annotation-based state definition
export const AgentStateAnnotation = Annotation.Root({
  ticketKey: Annotation<string>(),
  projectConfig: Annotation<ProjectConfig | undefined>({
    default: () => undefined,
    reducer: (_, next) => next,
  }),
  ticket: Annotation<GitHubIssue | undefined>({
    default: () => undefined,
    reducer: (_, next) => next,
  }),
  notionContext: Annotation<NotionPage[]>({
    default: () => [],
    reducer: (_, next) => next,
  }),
  memoryContext: Annotation<MemoryEntry[]>({
    default: () => [],
    reducer: (_, next) => next,
  }),
  // Shared query embedding — computed once in readNotion, reused in readMemory
  queryEmbedding: Annotation<number[] | undefined>({
    default: () => undefined,
    reducer: (_, next) => next,
  }),
  classification: Annotation<IssueClassification | undefined>({
    default: () => undefined,
    reducer: (_, next) => next,
  }),
  repoContext: Annotation<RepoFile[]>({
    default: () => [],
    reducer: (_, next) => next,
  }),
  generatedCode: Annotation<GeneratedCode | undefined>({
    default: () => undefined,
    reducer: (_, next) => next,
  }),
  pullRequest: Annotation<PullRequest | undefined>({
    default: () => undefined,
    reducer: (_, next) => next,
  }),
  notionDoc: Annotation<NotionDoc | undefined>({
    default: () => undefined,
    reducer: (_, next) => next,
  }),
  autoApprove: Annotation<boolean>({
    default: () => false,
    reducer: (_, next) => next,
  }),
  humanApproved: Annotation<boolean | undefined>({
    default: () => undefined,
    reducer: (_, next) => next,
  }),
  currentStep: Annotation<string>({
    default: () => "init",
    reducer: (_, next) => next,
  }),
  logs: Annotation<string[]>({
    default: () => [],
    reducer: (existing, next) => [...existing, ...next],
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;
