import { AgentState } from "../state.js";
import { GitHubIssuesClient } from "../../tools/github-issues.js";
import { getCommenter } from "../../tools/issueCommenter.js";

export async function markDone(state: AgentState): Promise<Partial<AgentState>> {
  const issues = new GitHubIssuesClient();
  const ticket = state.ticket!;
  const pr = state.pullRequest!;
  const doc = state.notionDoc;

  console.log(`\n[markDone] Closing GitHub Issue #${ticket.number}...`);

  await getCommenter(ticket.number).done();
  await issues.removeLabel(ticket.number, "in-progress");
  await issues.addLabel(ticket.number, "done");
  await issues.closeIssue(ticket.number);
  console.log(`[markDone] ✓ Issue closed and labelled "done"`);

  console.log("\n" + "=".repeat(70));
  console.log("  ✅ WORKFLOW COMPLETE");
  console.log("=".repeat(70));
  console.log(`  Issue:  #${ticket.number} — ${ticket.title}`);
  console.log(`  PR:     ${pr.url}`);
  if (doc) console.log(`  Docs:   ${doc.url}`);
  console.log("=".repeat(70) + "\n");

  return {
    currentStep: "done",
    logs: [
      `Issue #${ticket.number} closed`,
      `PR: ${pr.url}`,
      ...(doc ? [`Doc: ${doc.url}`] : []),
    ],
  };
}
