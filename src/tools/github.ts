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
    this.git.remote(["set-url", "origin", authenticatedRemote]).catch(() => {});
  }

  /**
   * Ensures the local repo exists and is ready:
   *   - Clones if the directory doesn't exist or isn't a git repo
   *   - Creates an initial commit + base branch if the repo is empty
   * Must be called before any git operations.
   */
  async ensureRepo(): Promise<void> {
    const token = process.env.GITHUB_TOKEN!;
    const authenticatedRemote = `https://${token}@github.com/${this.owner}/${this.repo}.git`;

    // ── Clone if not present ──────────────────────────────────────────────────
    const isGitRepo = fs.existsSync(path.join(this.localRepoPath, ".git"));
    if (!isGitRepo) {
      console.log(`[github] Cloning ${this.owner}/${this.repo} into ${this.localRepoPath}...`);
      fs.mkdirSync(this.localRepoPath, { recursive: true });
      const rootGit = simpleGit();
      await rootGit.clone(authenticatedRemote, this.localRepoPath);
      this.git = simpleGit(this.localRepoPath);
      console.log(`[github] ✅ Cloned`);
    }

    // Always ensure authenticated remote
    await this.git.remote(["set-url", "origin", authenticatedRemote]).catch(() => {});

    // ── Handle empty repo (no commits yet) ────────────────────────────────────
    try {
      await this.git.revparse(["HEAD"]);
      // HEAD exists — repo has commits, nothing to do
    } catch {
      console.log(`[github] Empty repo detected — creating initial commit on ${this.baseBranch}`);
      await this.git.raw(["checkout", "-b", this.baseBranch]);

      // Write a minimal README so the branch has a commit
      const readmePath = path.join(this.localRepoPath, "README.md");
      if (!fs.existsSync(readmePath)) {
        fs.writeFileSync(readmePath, `# ${this.repo}\n\nAI-generated Spring Boot project.\n`);
      }

      await this.git.add("README.md");
      await this.git.raw(["config", "user.email", "agent@ai-dev.bot"]);
      await this.git.raw(["config", "user.name",  "AI Engineering Agent"]);
      await this.git.commit("chore: initial commit");
      await this.git.push("origin", this.baseBranch, ["--set-upstream"]);
      console.log(`[github] ✅ Initial commit pushed`);
    }
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
    // Clones repo if not present locally; creates initial commit if repo is empty
    await this.ensureRepo();

    const branch = this.branchName(ticketKey, summary);

    // Ensure we're on the base branch and up to date
    await this.git.checkout(this.baseBranch);
    await this.git.pull("origin", this.baseBranch);

    // Delete local branch if it exists from a previous run
    const branches = await this.git.branchLocal();
    if (branches.all.includes(branch)) {
      console.log(`[github] Branch "${branch}" exists locally — deleting and recreating`);
      await this.git.deleteLocalBranch(branch, true);
    }
    // Delete remote branch too — stale remote branches cause "no commits" PR errors
    await this.git.raw(["push", "origin", "--delete", branch]).catch(() => {
      // Ignore — branch may not exist on remote yet
    });

    // Ensure git user is configured (required on Railway)
    await this.git.raw(["config", "user.email", "agent@ai-dev.bot"]).catch(() => {});
    await this.git.raw(["config", "user.name",  "AI Engineering Agent"]).catch(() => {});

    // Create and checkout the new feature branch
    await this.git.checkoutLocalBranch(branch);

    // Write files to disk
    for (const file of files) {
      const fullPath = path.join(this.localRepoPath, file.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, file.content, "utf8");
    }

    // Stage all new/modified files
    if (files.length === 0) {
      throw new Error(`No files generated for ticket #${ticketKey} — cannot commit empty changeset`);
    }
    const filePaths = files.map((f) => f.path);
    await this.git.add(filePaths);

    // Verify something is actually staged — git.commit() silently no-ops if nothing changed
    const staged = await this.git.diff(["--staged", "--name-only"]);
    if (!staged.trim()) {
      // Try staging everything as fallback (catches untracked files missed by path list)
      await this.git.add(["-A"]);
      const stagedRetry = await this.git.diff(["--staged", "--name-only"]);
      if (!stagedRetry.trim()) {
        throw new Error(
          `No file changes detected after staging for ticket #${ticketKey}. ` +
          `Generated code may be identical to what is already in main.`
        );
      }
    }

    return branch;
  }

  async commitAndPush(branch: string, ticketKey: string, summary: string): Promise<void> {
    const message = `feat(${ticketKey}): ${summary}`;
    // Commit — throws if nothing staged (belt-and-suspenders check)
    await this.git.commit(message);
    // Verify commit actually created something ahead of base
    const ahead = await this.git.raw(["rev-list", `origin/${this.baseBranch}..HEAD`, "--count"]).catch(() => "0");
    if (parseInt(ahead.trim(), 10) === 0) {
      throw new Error(`Commit produced no new commits ahead of ${this.baseBranch} — push skipped to avoid empty PR`);
    }
    await this.git.push("origin", branch, ["--set-upstream", "--force-with-lease"]).catch(() =>
      this.git.push("origin", branch, ["--set-upstream", "--force"])
    );
  }

  async createPullRequest(
    branch: string,
    title: string,
    body: string
  ): Promise<PullRequest> {
    try {
      const { data } = await this.octokit.pulls.create({
        owner: this.owner,
        repo:  this.repo,
        head:  branch,
        base:  this.baseBranch,
        title,
        body,
      });
      return { number: data.number, url: data.html_url, branch, title: data.title };
    } catch (err: unknown) {
      // If a PR already exists for this branch, find and return it
      const msg = (err as { message?: string }).message ?? "";
      if (msg.includes("A pull request already exists")) {
        const { data: prs } = await this.octokit.pulls.list({
          owner: this.owner,
          repo:  this.repo,
          head:  `${this.owner}:${branch}`,
          state: "open",
        });
        if (prs.length > 0) {
          const pr = prs[0];
          console.log(`[github] PR already exists — reusing PR #${pr.number}`);
          return { number: pr.number, url: pr.html_url, branch, title: pr.title };
        }
      }
      throw err;
    }
  }

  /**
   * Post a comment on a GitHub issue.
   * Used by the agent to report progress at each stage.
   */
  async addComment(issueNumber: number, body: string): Promise<void> {
    await this.octokit.issues.createComment({
      owner: this.owner,
      repo:  this.repo,
      issue_number: issueNumber,
      body,
    });
  }

  /**
   * Update an existing comment by ID.
   */
  async updateComment(commentId: number, body: string): Promise<void> {
    await this.octokit.issues.updateComment({
      owner:      this.owner,
      repo:       this.repo,
      comment_id: commentId,
      body,
    });
  }
}
