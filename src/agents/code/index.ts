/**
 * Code Agent
 *
 * Responsibilities:
 * - Listen for code.develop_requested events
 * - Run the LangGraph 13-node AI pipeline (classify → generate → PR)
 * - Handle PR reviews, test generation, deployment
 * - Manage human developer workflow
 * - Emit events back to Orchestrator on completion
 */

import { eventBus } from "../../shared/eventBus.js";
import {
  handleAIDevelop,
  handleAssign,
  handleHumanDevelop,
  handleDevDone,
  handleAIReview,
  handleDeploy,
  handleAITest,
  handleAssignTester,
  handleTesterReceived,
  handleClose,
  transitionStage,
} from "../../slack/workflow/engine.js";
import { getTicket } from "../../slack/workflow/store.js";
import { hasDevSession, answerDevQuestion, endDevSession } from "../../slack/devAssistant.js";

// ── Event listeners ────────────────────────────────────────────────────────────

export function initCodeAgent(): void {
  // Triggered when a ticket is assigned to AI development
  eventBus.on("code.develop_requested", async ({ issueNumber, mode, assigneeSlackId }) => {
    const ticket = getTicket(issueNumber);
    if (!ticket) {
      console.error(`[code] Ticket #${issueNumber} not found`);
      return;
    }

    try {
      if (mode === "ai") {
        const result = await handleAIDevelop(ticket, "ai");
        // Check if a PR was created after pipeline ran
        const updated = getTicket(issueNumber);
        if (updated?.prUrl) {
          eventBus.emit("code.pr_created", {
            issueNumber,
            prNumber: updated.prNumber ?? 0,
            prUrl:    updated.prUrl,
            branchName: updated.branchName ?? "",
          });
        }
        eventBus.emit("notify.channel", {
          channel: process.env.SLACK_DEFAULT_CHANNEL ?? "general",
          text:    result,
        });
      } else if (mode === "human" && assigneeSlackId) {
        const result = await handleHumanDevelop(ticket, assigneeSlackId);
        eventBus.emit("notify.user", { userId: assigneeSlackId, text: result });
      }
    } catch (err) {
      console.error(`[code] Development failed for #${issueNumber}:`, err);
      eventBus.emit("notify.channel", {
        channel: process.env.SLACK_DEFAULT_CHANNEL ?? "general",
        text:    `❌ Code generation failed for #${issueNumber}: ${(err as Error).message}`,
      });
    }
  });

  console.log("[code] ✅ Code Agent initialized");
}

// ── Public API for Slack router ────────────────────────────────────────────────

export async function handleCodeCommand(
  command: string,
  args: string,
  userId: string,
  channelId: string
): Promise<string> {
  // Dev assistant session takes priority
  if (hasDevSession(userId)) {
    if (["exit", "done", "quit", "bye"].includes(command.toLowerCase())) {
      endDevSession(userId);
      return "Dev session ended. Back to normal mode 👋";
    }
    return answerDevQuestion(userId, `${command} ${args}`.trim());
  }

  // Parse issue number from args
  const issueNum = parseInt(args.replace(/[^0-9]/g, ""), 10);

  switch (command.toLowerCase()) {
    case "assign": {
      if (!issueNum || !args) return "Usage: `assign <issue#> <name>`";
      const ticket = getTicket(issueNum);
      if (!ticket) return `❌ Ticket #${issueNum} not found`;
      return handleAssign(ticket, args.replace(/^\d+\s*/, "").trim(), userId);
    }

    case "dev done":
    case "devdone": {
      if (!issueNum) return "Usage: `dev done <issue#>`";
      const ticket = getTicket(issueNum);
      if (!ticket) return `❌ Ticket #${issueNum} not found`;
      return handleDevDone(ticket, userId);
    }

    case "review": {
      if (!issueNum) return "Usage: `review <issue#>`";
      const ticket = getTicket(issueNum);
      if (!ticket) return `❌ Ticket #${issueNum} not found`;
      return handleAIReview(ticket, userId);
    }

    case "deploy": {
      if (!issueNum) return "Usage: `deploy <issue#>`";
      const ticket = getTicket(issueNum);
      if (!ticket) return `❌ Ticket #${issueNum} not found`;
      return handleDeploy(ticket, userId);
    }

    case "close": {
      if (!issueNum) return "Usage: `close <issue#>`";
      const ticket = getTicket(issueNum);
      if (!ticket) return `❌ Ticket #${issueNum} not found`;
      const result = await handleClose(ticket, userId);
      // Emit closed event so Orchestrator sends closure summaries
      const updated = getTicket(issueNum);
      if (updated?.stage === "done") {
        eventBus.emit("ticket.closed", { ticket: updated });
      }
      return result;
    }

    default:
      return "";
  }
}
