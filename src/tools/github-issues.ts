import { Octokit } from "@octokit/rest";
import { GitHubIssue } from "../agent/state.js";

export class GitHubIssuesClient {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor() {
    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;

    if (!token || !owner || !repo) {
      throw new Error("Missing GITHUB_TOKEN, GITHUB_OWNER, or GITHUB_REPO");
    }

    this.octokit = new Octokit({ auth: token });
    this.owner = owner;
    this.repo = repo;
  }

  async getIssue(issueNumber: number): Promise<GitHubIssue> {
    const { data } = await this.octokit.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });

    return {
      number: data.number,
      title: data.title,
      body: data.body ?? "",
      state: data.state,
      labels: data.labels
        .map((l) => (typeof l === "string" ? l : l.name ?? ""))
        .filter(Boolean),
      url: data.html_url,
    };
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    try {
      // Ensure label exists (create if missing)
      try {
        await this.octokit.issues.getLabel({ owner: this.owner, repo: this.repo, name: label });
      } catch {
        await this.octokit.issues.createLabel({
          owner: this.owner,
          repo: this.repo,
          name: label,
          color: label === "in-progress" ? "0075ca" : "0e8a16",
        });
      }
      await this.octokit.issues.addLabels({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        labels: [label],
      });
    } catch (err) {
      console.warn(`[github-issues] ⚠ Could not add label "${label}" (skipping):`, (err as Error).message);
    }
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.issues.removeLabel({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        name: label,
      });
    } catch {
      // Label may not exist — ignore
    }
  }

  async addComment(issueNumber: number, body: string): Promise<void> {
    try {
      await this.octokit.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        body,
      });
    } catch (err) {
      console.warn(`[github-issues] ⚠ Could not comment on issue #${issueNumber} (skipping):`, (err as Error).message);
    }
  }

  async closeIssue(issueNumber: number): Promise<void> {
    try {
      await this.octokit.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        state: "closed",
      });
    } catch (err) {
      console.warn(`[github-issues] ⚠ Could not close issue #${issueNumber} (skipping):`, (err as Error).message);
    }
  }
}
