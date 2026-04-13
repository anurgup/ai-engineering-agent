/**
 * SDLC Workflow State Machine Engine.
 *
 * Each ticket moves through stages:
 *   backlog → in_dev → in_review → in_testing → done
 *
 * At each stage transition, the engine:
 *   1. Updates the ticket state
 *   2. Notifies relevant Slack users
 *   3. Triggers AI actions (code gen, PR review, test cases)
 *   4. Asks the next decision question
 */

import type { WorkflowTicket, TicketStage, AssigneeRole } from "./types.js";
import { getTicket, saveTicket, findUserByName, registerUser, getUser } from "./store.js";
import { notifyUser, notifyChannel, lookupSlackUser } from "../notifier.js";
import { generateTestCases, generateTestSuite, executeTestSuite, formatTestResults, formatTestSuitePreview } from "../testGenerator.js";
import { reviewPR } from "../prReviewer.js";
import { buildGraph } from "../../agent/graph.js";
import { startDevSession } from "../devAssistant.js";

// The main Slack channel to post status updates in
const STATUS_CHANNEL = process.env.SLACK_STATUS_CHANNEL ?? "general";

// ── Create a new workflow ticket ──────────────────────────────────────────────

export function createWorkflowTicket(
  issueNumber: number,
  title:       string,
  createdBy:   string,
  githubUrl?:  string
): WorkflowTicket {
  const now = new Date();
  const ticket: WorkflowTicket = {
    issueNumber,
    title,
    stage:          "backlog",
    createdBy,
    assigneeRole:   "unknown",
    developerMode:  "pending",
    testMode:       "pending",
    githubUrl,
    createdAt:      now,
    stageChangedAt: now,
    updatedAt:      now,
    history:        [{ stage: "backlog", changedBy: createdBy, at: now }],
  };
  saveTicket(ticket);
  return ticket;
}

// ── Stage transition ──────────────────────────────────────────────────────────

export async function transitionStage(
  issueNumber: number,
  newStage:    TicketStage,
  changedBy:   string,
  note?:       string
): Promise<WorkflowTicket> {
  const ticket = getTicket(issueNumber);
  if (!ticket) throw new Error(`Ticket #${issueNumber} not found`);

  const now = new Date();
  ticket.stage          = newStage;
  ticket.stageChangedAt = now;
  ticket.history.push({ stage: newStage, changedBy, note, at: now });
  saveTicket(ticket);

  await postStatusUpdate(ticket, note);
  return ticket;
}

// ── Decision handlers — called from Slack message router ─────────────────────

/**
 * BA just created a ticket. Ask: AI develop or assign to someone?
 */
export async function handleNewTicket(
  ticket:    WorkflowTicket,
  channelId: string
): Promise<string> {
  return (
    `📋 *New ticket created: #${ticket.issueNumber}*\n` +
    `*${ticket.title}*\n\n` +
    `What should I do?\n` +
    `• Type \`develop\` — AI writes the code now\n` +
    `• Type \`assign <name>\` — assign to a developer (e.g. \`assign John\`)\n` +
    `• Type \`status\` — see full pipeline`
  );
}

/**
 * User said "develop" — trigger AI agent, move to in_dev
 */
export async function handleAIDevelop(
  ticket:    WorkflowTicket,
  userId:    string
): Promise<string> {
  ticket.developerMode = "ai";
  await transitionStage(ticket.issueNumber, "in_dev", userId, "AI developing");
  saveTicket(ticket);

  // Fire the AI agent in background
  const graph = buildGraph();
  graph
    .invoke({ ticketKey: String(ticket.issueNumber), autoApprove: true })
    .then(async (result) => {
      // Persist PR info returned by pushToGitHub node into the workflow ticket
      const updated = getTicket(ticket.issueNumber) ?? ticket;
      if (result?.pullRequest) {
        updated.prNumber = result.pullRequest.number;
        updated.prUrl    = result.pullRequest.url;
        saveTicket(updated);
      }
      await transitionStage(ticket.issueNumber, "in_review", "ai", "AI finished coding");

      const msg = [
        `✅ *AI finished coding for #${ticket.issueNumber}: ${ticket.title}*`,
        updated.prUrl ? `🔀 PR: ${updated.prUrl}` : "",
        ``,
        `What would you like to do next?`,
        `• \`review ${ticket.issueNumber}\` — AI reviews the PR for code quality`,
        `• \`deploy ${ticket.issueNumber}\` — deploy to staging and start testing`,
        `• \`close ${ticket.issueNumber}\` — close the ticket as done`,
      ].filter(Boolean).join("\n");

      await notifyUser(userId, msg);
    })
    .catch(async (err: unknown) => {
      const errMsg = `❌ *AI coding failed for #${ticket.issueNumber}*: ${err instanceof Error ? err.message : String(err)}`;
      await notifyUser(userId, errMsg);
    });

  return (
    `🤖 *AI is now developing #${ticket.issueNumber}*\n` +
    `I'll notify you when the PR is ready. This usually takes 2-3 minutes.`
  );
}

/**
 * User said "assign <name>" — look up user, ping them
 */
export async function handleAssign(
  ticket:      WorkflowTicket,
  assigneeName: string,
  assignedBy:  string,
  role:        AssigneeRole = "developer"
): Promise<string> {
  // Try to find user in registry first
  let user = findUserByName(assigneeName);

  // If not found, try Slack API lookup
  if (!user) {
    const slackUser = await lookupSlackUser(assigneeName);
    if (slackUser) {
      registerUser({ ...slackUser, role });
      user = slackUser;
    }
  }

  if (!user) {
    return (
      `❓ I couldn't find *${assigneeName}* in Slack.\n` +
      `Make sure they're in this workspace. Try their exact display name.`
    );
  }

  ticket.assigneeSlackId = user.id;
  ticket.assigneeName    = user.realName || user.name;
  ticket.assigneeRole    = role;
  saveTicket(ticket);

  await transitionStage(ticket.issueNumber, "in_dev", assignedBy, `Assigned to ${ticket.assigneeName}`);

  // Ping the assignee
  await notifyUser(
    user.id,
    `👋 *You've been assigned ticket #${ticket.issueNumber}*\n` +
    `*${ticket.title}*\n` +
    `${ticket.githubUrl ? `GitHub: ${ticket.githubUrl}\n` : ""}` +
    `\nShould I develop this for you or will you do it yourself?\n` +
    `• Type \`ai develop ${ticket.issueNumber}\` — I'll write the code\n` +
    `• Type \`i'll do it ${ticket.issueNumber}\` — you code, I'll help when ready`
  );

  return (
    `✅ *#${ticket.issueNumber} assigned to ${ticket.assigneeName}*\n` +
    `I've sent them a DM. I'll keep you posted on progress.`
  );
}

/**
 * Developer said "I'll do it myself" — activate dev assistant
 */
export async function handleHumanDevelop(
  ticket: WorkflowTicket,
  userId: string
): Promise<string> {
  ticket.developerMode = "human";
  saveTicket(ticket);

  // Start the RAG-powered dev assistant for this developer
  startDevSession(userId, ticket.issueNumber, ticket.title);

  return (
    `Got it! You're coding *#${ticket.issueNumber}* yourself. 💪\n\n` +
    `I'm your coding assistant — ask me anything while you develop:\n` +
    `• _"How should I structure this?"_\n` +
    `• _"Show me the pattern used in similar files"_\n` +
    `• _"What's the best way to write the DAO method?"_\n\n` +
    `I'll answer based on *your actual codebase* — not generic advice.\n\n` +
    `When you're done: \`done ${ticket.issueNumber}\``
  );
}

/**
 * Developer said "done <number>" — move to in_review, ask about deploy
 */
export async function handleDevDone(
  ticket: WorkflowTicket,
  userId: string
): Promise<string> {
  await transitionStage(ticket.issueNumber, "in_review", userId, "Developer marked done");

  return (
    `🎉 *#${ticket.issueNumber} development complete!*\n\n` +
    `What's next?\n` +
    `• \`deploy ${ticket.issueNumber}\` — deploy to staging\n` +
    `• \`review ${ticket.issueNumber}\` — AI reviews the code first\n` +
    `• \`skip deploy ${ticket.issueNumber}\` — go straight to testing`
  );
}

/**
 * AI PR review
 */
export async function handleAIReview(
  ticket: WorkflowTicket,
  userId: string
): Promise<string> {
  // If prNumber missing from store (e.g. after restart), look it up from GitHub
  if (!ticket.prNumber) {
    try {
      const owner = process.env.GITHUB_OWNER;
      const repo  = process.env.GITHUB_REPO;
      const token = process.env.GITHUB_TOKEN;
      if (owner && repo && token) {
        const resp = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=20`,
          { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" } }
        );
        if (resp.ok) {
          const prs = await resp.json() as Array<{ number: number; title: string; html_url: string }>;
          const pr  = prs.find((p) => p.title.includes(`#${ticket.issueNumber}`) || p.title.toLowerCase().includes(ticket.title.toLowerCase().slice(0, 20)));
          if (pr) {
            ticket.prNumber = pr.number;
            ticket.prUrl    = pr.html_url;
            saveTicket(ticket);
          }
        }
      }
    } catch { /* ignore */ }
  }

  if (!ticket.prNumber) {
    return `No PR found for #${ticket.issueNumber} yet. Wait for the AI to finish coding.`;
  }

  await notifyUser(ticket.createdBy ?? userId, `🔍 AI is reviewing PR #${ticket.prNumber} for ticket #${ticket.issueNumber}...`);

  try {
    const review = await reviewPR(ticket.prNumber, ticket.issueNumber, ticket.title);
    return (
      `🔍 *AI Code Review for #${ticket.issueNumber}*\n\n${review}\n\n` +
      `• \`deploy ${ticket.issueNumber}\` — deploy to staging\n` +
      `• \`skip deploy ${ticket.issueNumber}\` — go to testing without deploy`
    );
  } catch (err) {
    return `❌ Review failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Deploy to staging
 */
export async function handleDeploy(
  ticket: WorkflowTicket,
  userId: string
): Promise<string> {
  await transitionStage(ticket.issueNumber, "in_testing", userId, "Deploying to staging");

  // Trigger Render/Railway deploy hook if configured
  const deployHook = process.env.RENDER_DEPLOY_HOOK_URL ?? process.env.STAGING_DEPLOY_HOOK;
  if (deployHook) {
    try {
      await fetch(deployHook, { method: "POST" });
      console.log(`[workflow] Deploy hook triggered for #${ticket.issueNumber}`);
    } catch {
      console.warn(`[workflow] Deploy hook failed for #${ticket.issueNumber}`);
    }
  }

  return (
    `🚀 *#${ticket.issueNumber} deployed to staging!*\n\n` +
    `How would you like to test it?\n` +
    `• \`i want to test ${ticket.issueNumber}\` — AI generates test cases + curl commands, you run them\n` +
    `• \`ai test ${ticket.issueNumber}\` — AI generates AND executes all tests automatically\n` +
    `• \`assign tester <name> ${ticket.issueNumber}\` — assign to a human tester`
  );
}

/**
 * AI generates test cases
 */
export async function handleAITest(
  ticket: WorkflowTicket,
  userId: string
): Promise<string> {
  ticket.testMode = "ai";
  saveTicket(ticket);

  try {
    await notifyUser(userId, `🧪 Generating and executing tests for #${ticket.issueNumber}... this may take a minute.`);

    const suite   = await generateTestSuite(ticket.issueNumber, ticket.title);
    const results = await executeTestSuite(suite);
    const summary = formatTestResults(suite, results);

    ticket.testCases = formatTestSuitePreview(suite);
    saveTicket(ticket);

    return summary;
  } catch (err) {
    return `❌ Test execution failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * User wants to test manually — generate test plan with curls but don't execute
 */
export async function handleUserTest(
  ticket: WorkflowTicket,
  userId: string
): Promise<string> {
  ticket.testMode = "human";
  saveTicket(ticket);

  try {
    const suite   = await generateTestSuite(ticket.issueNumber, ticket.title);
    const preview = formatTestSuitePreview(suite);

    ticket.testCases = preview;
    saveTicket(ticket);

    return preview;
  } catch (err) {
    return `❌ Test plan generation failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Run the saved test suite (after user reviewed the plan)
 */
export async function handleRunTests(
  ticket: WorkflowTicket,
  userId: string
): Promise<string> {
  try {
    await notifyUser(userId, `⚡ Running tests for #${ticket.issueNumber}...`);
    const suite   = await generateTestSuite(ticket.issueNumber, ticket.title);
    const results = await executeTestSuite(suite);
    return formatTestResults(suite, results);
  } catch (err) {
    return `❌ Test run failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Assign to tester
 */
export async function handleAssignTester(
  ticket:      WorkflowTicket,
  testerName:  string,
  assignedBy:  string
): Promise<string> {
  return handleAssign(ticket, testerName, assignedBy, "tester");
}

/**
 * Tester received ticket — ask if they want AI test cases
 */
export async function handleTesterReceived(
  ticket: WorkflowTicket,
  userId: string
): Promise<string> {
  return (
    `🧪 *You've been assigned to test #${ticket.issueNumber}*\n` +
    `*${ticket.title}*\n\n` +
    `• \`ai test ${ticket.issueNumber}\` — AI generates test cases for you\n` +
    `• \`test myself ${ticket.issueNumber}\` — you'll write your own tests`
  );
}

/**
 * Close the ticket
 */
export async function handleClose(
  ticket:  WorkflowTicket,
  userId:  string,
  passed?: boolean
): Promise<string> {
  await transitionStage(ticket.issueNumber, "done", userId, passed ? "All tests passed" : "Closed");

  // Close GitHub issue via API
  const owner = process.env.GITHUB_OWNER;
  const repo  = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;

  if (owner && repo && token) {
    await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${ticket.issueNumber}`, {
      method:  "PATCH",
      headers: {
        Authorization:  `token ${token}`,
        Accept:         "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state: "closed" }),
    }).catch(() => console.warn(`[workflow] Could not close GitHub issue #${ticket.issueNumber}`));
  }

  // Notify creator
  if (ticket.createdBy) {
    await notifyUser(
      ticket.createdBy,
      `✅ *Ticket #${ticket.issueNumber} is DONE!*\n` +
      `*${ticket.title}*\n` +
      `${passed ? "All tests passed. " : ""}Issue closed on GitHub.`
    );
  }

  return (
    `🎉 *#${ticket.issueNumber} is DONE!*\n` +
    `*${ticket.title}*\n\n` +
    `GitHub issue closed. Great work! 🚀`
  );
}

// ── Status update ─────────────────────────────────────────────────────────────

const STAGE_EMOJI: Record<TicketStage, string> = {
  backlog:    "📋",
  in_dev:     "👨‍💻",
  in_review:  "🔍",
  in_testing: "🧪",
  done:       "✅",
  blocked:    "🚫",
};

async function postStatusUpdate(ticket: WorkflowTicket, note?: string): Promise<void> {
  const emoji    = STAGE_EMOJI[ticket.stage];
  const assignee = ticket.assigneeName ? ` · ${ticket.assigneeName}` : "";
  const noteStr  = note ? `\n_${note}_` : "";
  const msg      =
    `${emoji} *#${ticket.issueNumber}* moved to *${ticket.stage.replace("_", " ").toUpperCase()}*${assignee}${noteStr}\n` +
    `_${ticket.title}_`;

  // Only post to channel if a real channel ID is configured (not the default "general")
  const channel = process.env.SLACK_STATUS_CHANNEL;
  if (channel && channel !== "general") {
    await notifyChannel(channel, msg);
  } else if (ticket.createdBy) {
    // Fall back to DMing the ticket creator
    await notifyUser(ticket.createdBy, msg);
  }
}
