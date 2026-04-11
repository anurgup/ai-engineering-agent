import { AgentState } from "../state.js";
import { GitHubIssuesClient } from "../../tools/github-issues.js";
import { getCommenter } from "../../tools/issueCommenter.js";

export async function readTicket(state: AgentState): Promise<Partial<AgentState>> {
  const issues = new GitHubIssuesClient();
  const issueNumber = parseInt(state.ticketKey, 10);

  if (isNaN(issueNumber)) {
    throw new Error(`Invalid issue number: "${state.ticketKey}". Expected a numeric GitHub issue number.`);
  }

  console.log(`\n[readTicket] Fetching GitHub Issue #${issueNumber}...`);
  const ticket = await issues.getIssue(issueNumber);
  console.log(`[readTicket] ✓ "${ticket.title}" (${ticket.state})`);

  await issues.addLabel(issueNumber, "in-progress");
  console.log(`[readTicket] ✓ Label "in-progress" added`);

  // Start progress comment — all future stages update this same comment
  const commenter = getCommenter(issueNumber);
  await commenter.started();

  return {
    ticket,
    currentStep: "readTicket",
    logs: [`Fetched issue #${issueNumber}: ${ticket.title}`, `Label "in-progress" added`],
  };
}
