import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env"), override: true });
import { buildGraph } from "./agent/graph.js";

async function main() {
  const args = process.argv.slice(2);
  const issueIndex = args.indexOf("--issue");

  if (issueIndex === -1 || !args[issueIndex + 1]) {
    console.error("Usage: npm run ticket -- --issue 42");
    process.exit(1);
  }

  const ticketKey = args[issueIndex + 1];

  if (isNaN(parseInt(ticketKey, 10))) {
    console.error(`Invalid issue number: "${ticketKey}". Must be a numeric GitHub issue number.`);
    process.exit(1);
  }

  console.log(`\n🤖 AI Engineering Agent`);
  console.log(`   Issue:  #${ticketKey}`);
  console.log(`   Mode:   CLI\n`);

  const graph = buildGraph();

  try {
    await graph.invoke({ ticketKey });
  } catch (err) {
    console.error("\n❌ Agent failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
