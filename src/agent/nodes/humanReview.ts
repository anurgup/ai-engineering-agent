import * as readline from "readline";
import { AgentState } from "../state.js";

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function humanReview(state: AgentState): Promise<Partial<AgentState>> {
  const code = state.generatedCode!;
  const ticket = state.ticket!;

  console.log("\n" + "=".repeat(70));
  console.log("  HUMAN REVIEW — AI-Generated Code");
  console.log("=".repeat(70));
  console.log(`\nIssue: #${ticket.number} — ${ticket.title}`);
  console.log(`\nSummary: ${code.summary}`);

  if (code.dependencies.length > 0) {
    console.log(`\nNew dependencies: ${code.dependencies.join(", ")}`);
  }

  console.log(`\n${"─".repeat(70)}`);
  console.log(`  Generated Files (${code.files.length})`);
  console.log("─".repeat(70));

  for (const file of code.files) {
    console.log(`\n📄 ${file.path}`);
    console.log("─".repeat(50));
    console.log(file.content);
    console.log();
  }

  console.log("─".repeat(70));
  console.log(`  Test Instructions`);
  console.log("─".repeat(70));
  console.log(code.testInstructions);
  console.log("=".repeat(70));

  // Webhook mode — no terminal available, auto-approve and proceed
  if (state.autoApprove) {
    console.log("\n[humanReview] ⚡ Webhook mode — auto-approving and pushing to GitHub");
    return {
      humanApproved: true,
      currentStep: "humanReview",
      logs: ["Human review: AUTO-APPROVED (webhook mode)"],
    };
  }

  // CLI mode — wait for human input
  const answer = await prompt(
    "\n✋ Approve this code? Type 'yes' to push to GitHub, 'no' to reject: "
  );

  const approved = answer.toLowerCase() === "yes";

  if (approved) {
    console.log("\n[humanReview] ✓ Approved — proceeding to push to GitHub");
  } else {
    console.log("\n[humanReview] ✗ Rejected — stopping workflow");
  }

  return {
    humanApproved: approved,
    currentStep: "humanReview",
    logs: [`Human review: ${approved ? "APPROVED" : "REJECTED"}`],
  };
}
