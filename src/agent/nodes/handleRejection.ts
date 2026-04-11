import { AgentState } from "../state.js";
import { GitHubIssuesClient } from "../../tools/github-issues.js";
import { getCommenter } from "../../tools/issueCommenter.js";

export async function handleRejection(state: AgentState): Promise<Partial<AgentState>> {
  const issues = new GitHubIssuesClient();
  const ticket = state.ticket!;

  console.log(`\n[handleRejection] Logging rejection on Issue #${ticket.number}...`);

  await getCommenter(ticket.number).rejected("Human rejected the generated code — returned for manual implementation");

  await issues.removeLabel(ticket.number, "in-progress");
  console.log(`[handleRejection] ✓ Label "in-progress" removed, issue left open`);

  console.log("\n" + "=".repeat(70));
  console.log("  ✗ WORKFLOW ENDED — Code Rejected");
  console.log("=".repeat(70) + "\n");

  return {
    currentStep: "rejected",
    logs: [`Code rejected by developer. Issue #${ticket.number} left open.`],
  };
}
