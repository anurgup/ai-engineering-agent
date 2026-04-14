import Anthropic from "@anthropic-ai/sdk";
import { AgentState } from "../state.js";
import { NotionClient } from "../../tools/notion.js";
import { buildNotionDocPrompt } from "../../prompts/notionDoc.js";
import { addPageToIndex } from "./readNotion.js";
import { getCommenter } from "../../tools/issueCommenter.js";

const MODEL = "claude-haiku-4-5-20251001";

export async function updateNotion(state: AgentState): Promise<Partial<AgentState>> {
  // Skip gracefully if PR or code is missing (e.g. rejection path)
  if (!state.pullRequest || !state.generatedCode) {
    console.log(`[updateNotion] Skipping — no PR or generated code in state`);
    return { currentStep: "updateNotion", logs: ["Notion update skipped (no PR)"] };
  }

  const client = new Anthropic();
  const notion = new NotionClient();
  const ticket = state.ticket!;
  const code = state.generatedCode;
  const pr = state.pullRequest;

  console.log(`\n[updateNotion] Generating Notion doc with Claude Haiku...`);

  const docPrompt = buildNotionDocPrompt(ticket, code, pr);

  const docResponse = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{ role: "user", content: docPrompt }],
  });

  const markdownContent =
    docResponse.content[0].type === "text" ? docResponse.content[0].text : "";

  const pageTitle = `Issue #${ticket.number}: ${ticket.title}`;

  let notionDoc;
  try {
    const result = await notion.upsertPage(pageTitle, markdownContent);
    notionDoc = { id: result.id, url: result.url, title: pageTitle };
    console.log(`[updateNotion] ✓ Page ${result.created ? "created" : "updated"}: ${notionDoc.url}`);

    // ── Instantly add this page to the RAG index so future tickets find it ──
    await addPageToIndex({
      id:      result.id,
      title:   pageTitle,
      url:     result.url,
      excerpt: markdownContent.slice(0, 1500),
    });
  } catch (err) {
    console.warn(`[updateNotion] ⚠ Failed to create Notion page:`, err);
    return {
      currentStep: "updateNotion",
      logs: [`Notion page creation failed (non-fatal)`],
    };
  }

  await getCommenter(state.ticket!.number).notionUpdated(notionDoc.url);

  return {
    notionDoc,
    currentStep: "updateNotion",
    logs: [`Notion doc created: ${notionDoc.url}`],
  };
}
