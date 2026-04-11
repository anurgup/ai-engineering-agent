/**
 * Issue Commenter — posts progress updates as GitHub issue comments.
 *
 * Every agent stage posts a comment so the ticket tells the full story:
 *
 *   🤖 Agent started
 *   🔍 Analysed issue — fresh feature, Java Spring Boot
 *   📚 Found 2 relevant Notion pages
 *   🧠 Found 3 similar past PRs
 *   📂 Reading 4 existing files
 *   ⚙️  Generating code...
 *   ✅ Code generated — 3 files changed
 *   🚀 PR #27 created → <link>
 *   🧪 Test cases generated
 *   📝 Notion page updated
 *   ✅ Done!
 *
 * Also supports:
 *   - User custom comments via Slack: "comment on #25: looks good"
 *   - Asking user what to add: "what should I note on this ticket?"
 */

import { GitHubClient } from "./github.js";

// One commenter instance per issue number
const commenters = new Map<number, IssueCommenter>();

export function getCommenter(issueNumber: number): IssueCommenter {
  if (!commenters.has(issueNumber)) {
    commenters.set(issueNumber, new IssueCommenter(issueNumber));
  }
  return commenters.get(issueNumber)!;
}

export class IssueCommenter {
  private issueNumber: number;
  private github: GitHubClient | null = null;
  private progressCommentId: number | null = null;
  private stages: string[] = [];

  constructor(issueNumber: number) {
    this.issueNumber = issueNumber;
    try {
      this.github = new GitHubClient();
    } catch {
      // GitHub not configured — silent fail
      this.github = null;
    }
  }

  // ── Progress comment (single comment updated at each stage) ──────────────

  /**
   * Post or update the live progress comment.
   * All stages are accumulated into one comment — keeps ticket clean.
   */
  async updateProgress(stage: string, emoji: string, detail?: string): Promise<void> {
    if (!this.github) return;

    this.stages.push(`${emoji} **${stage}**${detail ? ` — ${detail}` : ""}`);

    const body = this.buildProgressBody();

    try {
      if (this.progressCommentId) {
        // Update existing comment
        await this.github.updateComment(this.progressCommentId, body);
      } else {
        // Create first comment
        const resp = await (this.github as unknown as {
          octokit: { issues: { createComment: (p: object) => Promise<{ data: { id: number } }> } };
          owner: string;
          repo: string;
        }).octokit.issues.createComment({
          owner:        (this.github as unknown as { owner: string }).owner,
          repo:         (this.github as unknown as { repo: string }).repo,
          issue_number: this.issueNumber,
          body,
        });
        this.progressCommentId = resp.data.id;
      }
    } catch (err) {
      console.warn(`[commenter] Failed to update progress comment:`, err);
    }
  }

  // ── Standalone comments ───────────────────────────────────────────────────

  /**
   * Post a standalone comment (not part of progress).
   * Used for: PR links, test results, user notes.
   */
  async postComment(body: string): Promise<void> {
    if (!this.github) return;
    try {
      await this.github.addComment(this.issueNumber, body);
    } catch (err) {
      console.warn(`[commenter] Failed to post comment:`, err);
    }
  }

  // ── Stage-specific helpers ────────────────────────────────────────────────

  async started(): Promise<void> {
    await this.updateProgress("AI Agent Started", "🤖", "Processing your ticket...");
  }

  async classified(type: string, stack: string): Promise<void> {
    await this.updateProgress("Issue Analysed", "🔍", `${type} · ${stack}`);
  }

  async notionFound(count: number): Promise<void> {
    if (count === 0) return;
    await this.updateProgress("Notion Context", "📚", `${count} relevant page${count !== 1 ? "s" : ""} found`);
  }

  async memoryFound(count: number): Promise<void> {
    if (count === 0) return;
    await this.updateProgress("Past PRs", "🧠", `${count} similar PR${count !== 1 ? "s" : ""} found`);
  }

  async readingFiles(count: number, files: string[]): Promise<void> {
    const fileList = files.slice(0, 3).join(", ") + (files.length > 3 ? "..." : "");
    await this.updateProgress("Reading Codebase", "📂", `${count} file${count !== 1 ? "s" : ""}: ${fileList}`);
  }

  async generatingCode(): Promise<void> {
    await this.updateProgress("Generating Code", "⚙️", "Writing implementation...");
  }

  async codeGenerated(files: string[]): Promise<void> {
    const fileList = files.map((f) => `\`${f}\``).join(", ");
    await this.updateProgress("Code Generated", "✅", `${files.length} file${files.length !== 1 ? "s" : ""}: ${fileList}`);
  }

  async prCreated(prNumber: number, prUrl: string): Promise<void> {
    await this.updateProgress("Pull Request Created", "🚀", `[PR #${prNumber}](${prUrl})`);
    // Also post a standalone comment with the PR link for visibility
    await this.postComment(
      `🚀 **Pull Request Created**\n\n` +
      `[PR #${prNumber}: View Changes](${prUrl})\n\n` +
      `> AI-generated code is ready for review.`
    );
  }

  async testsGenerated(testCases: string): Promise<void> {
    await this.updateProgress("Test Cases Generated", "🧪");
    await this.postComment(
      `🧪 **AI-Generated Test Cases**\n\n${testCases}`
    );
  }

  async notionUpdated(notionUrl: string): Promise<void> {
    await this.updateProgress("Notion Updated", "📝", `[View doc](${notionUrl})`);
  }

  async done(): Promise<void> {
    await this.updateProgress("Completed", "🎉", "All done!");
  }

  async rejected(reason?: string): Promise<void> {
    await this.updateProgress("Rejected", "❌", reason ?? "Human rejected the generated code");
  }

  /**
   * Post a custom user comment on the ticket.
   * Called from Slack: "comment on #25: this looks good"
   */
  async userComment(userName: string, comment: string): Promise<void> {
    await this.postComment(`💬 **${userName} via Slack:**\n\n${comment}`);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private buildProgressBody(): string {
    const lines = [
      `## 🤖 AI Agent Progress`,
      ``,
      ...this.stages,
      ``,
      `---`,
      `_Last updated: ${new Date().toLocaleString()}_`,
    ];
    return lines.join("\n");
  }
}
