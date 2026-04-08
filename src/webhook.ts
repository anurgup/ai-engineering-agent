import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env"), override: true });
import express, { Request, Response } from "express";
import * as crypto from "crypto";
import { buildGraph } from "./agent/graph.js";

// Extend Request to carry the raw body buffer for HMAC verification
interface RawRequest extends Request {
  rawBody?: Buffer;
}

const app = express();

// Railway injects PORT dynamically — always prefer it over WEBHOOK_PORT
const PORT   = parseInt(process.env.PORT ?? process.env.WEBHOOK_PORT ?? "3000", 10);
const SECRET = process.env.WEBHOOK_SECRET ?? "";

// GitHub issue actions that should trigger the agent
const TRIGGER_ACTIONS = new Set(["opened", "reopened"]);

// Capture raw body BEFORE JSON parsing — GitHub HMAC is computed on raw bytes
app.use(
  express.json({
    verify: (req: RawRequest, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

function validateSignature(req: RawRequest): boolean {
  if (!SECRET) return true; // skip if no secret configured

  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  if (!signature) return false;

  // Must use raw bytes — JSON.stringify would produce a different hash
  const payload = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
  const hmac    = crypto.createHmac("sha256", SECRET);
  hmac.update(payload);
  const expected = `sha256=${hmac.digest("hex")}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// GitHub Issues webhook
app.post("/webhook/github", async (req: RawRequest, res: Response) => {
  if (!validateSignature(req)) {
    console.warn(`[webhook] ⚠ Invalid signature — request rejected`);
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const event = req.headers["x-github-event"] as string | undefined;
  if (event !== "issues") {
    res.json({ skipped: true, reason: `Event "${event}" is not an issues event` });
    return;
  }

  const action: string      = req.body.action ?? "";
  const issueNumber: number = req.body.issue?.number;
  const issueTitle: string  = req.body.issue?.title ?? "";

  console.log(`\n[webhook] GitHub Issues event: action="${action}" | Issue #${issueNumber}`);

  if (!TRIGGER_ACTIONS.has(action) || !issueNumber) {
    res.json({ skipped: true, reason: `Action "${action}" does not trigger agent` });
    return;
  }

  // Acknowledge immediately — run agent async
  res.json({ accepted: true, issueNumber });

  console.log(`\n🤖 AI Engineering Agent`);
  console.log(`   Issue:  #${issueNumber} — ${issueTitle}`);
  console.log(`   Mode:   Webhook (Railway)\n`);

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
  console.log(`\n🤖 AI Engineering Agent — Webhook Mode (Railway)`);
  console.log(`   Listening on port ${PORT}`);
  console.log(`   Endpoint: POST /webhook/github`);
  console.log(`   Health:   GET  /health\n`);
});
