import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env"), override: true });
import express, { Request, Response } from "express";
import * as crypto from "crypto";
import { buildGraph } from "./agent/graph.js";

const app = express();
app.use(express.json());

// Railway injects PORT dynamically — always prefer it over WEBHOOK_PORT
const PORT = parseInt(process.env.PORT ?? process.env.WEBHOOK_PORT ?? "3000", 10);
const SECRET = process.env.WEBHOOK_SECRET ?? "";

// GitHub issue actions that should trigger the agent
const TRIGGER_ACTIONS = new Set(["opened", "reopened"]);

function validateSignature(req: Request): boolean {
  if (!SECRET) return true; // Skip validation if no secret configured

  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  if (!signature) return false;

  const hmac = crypto.createHmac("sha256", SECRET);
  hmac.update(JSON.stringify(req.body));
  const expected = `sha256=${hmac.digest("hex")}`;

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// GitHub Issues webhook (from GitHub repo settings → Webhooks)
app.post("/webhook/github", async (req: Request, res: Response) => {
  if (!validateSignature(req)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const event = req.headers["x-github-event"] as string | undefined;
  if (event !== "issues") {
    res.json({ skipped: true, reason: `Event "${event}" is not an issues event` });
    return;
  }

  const action: string = req.body.action ?? "";
  const issueNumber: number = req.body.issue?.number;
  const issueTitle: string = req.body.issue?.title ?? "";

  console.log(`\n[webhook] GitHub Issues event: action="${action}" | Issue #${issueNumber}`);

  if (!TRIGGER_ACTIONS.has(action) || !issueNumber) {
    res.json({ skipped: true, reason: `Action "${action}" does not trigger agent` });
    return;
  }

  // Acknowledge immediately, run agent async
  res.json({ accepted: true, issueNumber });

  console.log(`\n🤖 AI Engineering Agent`);
  console.log(`   Issue:  #${issueNumber} — ${issueTitle}`);
  console.log(`   Mode:   Webhook\n`);

  const graph = buildGraph();

  graph.invoke({ ticketKey: String(issueNumber), autoApprove: true }).catch((err: unknown) => {
    console.error(
      `\n❌ Agent failed for issue #${issueNumber}:`,
      err instanceof Error ? err.message : err
    );
  });
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`\n🤖 AI Engineering Agent — Webhook Mode`);
  console.log(`   Listening on port ${PORT}`);
  console.log(`   Endpoint: POST /webhook/github`);
  console.log(`   Health:   GET  /health\n`);
});
