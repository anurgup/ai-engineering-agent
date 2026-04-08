import { Octokit } from "@octokit/rest";
import { simpleGit, SimpleGit } from "simple-git";
import * as fs from "fs";
import * as path from "path";
import { GeneratedFile, PullRequest } from "../agent/state.js";

export class GitHubClient {
  private octokit: Octokit;
  private git: SimpleGit;
  private owner: string;
  private repo: string;
  private baseBranch: string;
  private localRepoPath: string;

  constructor() {
    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const baseBranch = process.env.GITHUB_BASE_BRANCH ?? "main";
    const localRepoPath = process.env.LOCAL_REPO_PATH;

    if (!token || !owner || !repo || !localRepoPath) {
      throw new Error(
        "Missing GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, or LOCAL_REPO_PATH"
      );
    }

    this.octokit = new Octokit({ auth: token });
    this.owner = owner;
    this.repo = repo;
    this.baseBranch = baseBranch;
    this.localRepoPath = localRepoPath;
    this.git = simpleGit(localRepoPath);

    // Inject token into remote URL so pushes are authenticated
    const authenticatedRemote = `https://${token}@github.com/${owner}/${repo}.git`;
    this.git.remote(["set-url", "origin", authenticatedRemote]).catch(() => {
      // Remote may not be set yet — ignore, will be caught at push time
    });
  }

  branchName(ticketKey: string, summary: string): string {
    const slug = summary
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 40);
    return `feature/${ticketKey}-${slug}`;
  }

  async createBranchAndWriteFiles(
    ticketKey: string,
    summary: string,
    files: GeneratedFile[]
  ): Promise<string> {
    const branch = this.branchName(ticketKey, summary);

    // Ensure we're on the base branch and up to date
    await this.git.checkout(this.baseBranch);
    await this.git.pull("origin", this.baseBranch);

    // Create and checkout the new feature branch
    await this.git.checkoutLocalBranch(branch);

    // Write files to disk
    for (const file of files) {
      const fullPath = path.join(this.localRepoPath, file.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, file.content, "utf8");
    }

    // Stage all new/modified files
    const filePaths = files.map((f) => f.path);
    await this.git.add(filePaths);

    return branch;
  }

  async commitAndPush(branch: string, ticketKey: string, summary: string): Promise<void> {
    const message = `feat(${ticketKey}): ${summary}`;
    await this.git.commit(message);
    await this.git.push("origin", branch, ["--set-upstream"]);
  }

  async createPullRequest(
    branch: string,
    title: string,
    body: string
  ): Promise<PullRequest> {
    const { data } = await this.octokit.pulls.create({
      owner: this.owner,
      repo: this.repo,
      head: branch,
      base: this.baseBranch,
      title,
      body,
    });

    return {
      number: data.number,
      url: data.html_url,
      branch,
      title: data.title,
    };
  }
}
