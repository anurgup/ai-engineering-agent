import { Client } from "@notionhq/client";
import { NotionPage } from "../agent/state.js";

const EXCERPT_MAX_CHARS = 1500;
const MAX_PAGES         = 5;    // keyword search results cap
const MAX_INDEX_PAGES   = 200;  // how many pages to pull when building the RAG index
const BLOCKS_PER_PAGE   = 20;

type NotionBlock = {
  type: string;
  [key: string]: unknown;
};

type NotionRichText = {
  plain_text?: string;
};

function extractPlainText(block: NotionBlock): string {
  const richTextTypes = [
    "paragraph",
    "heading_1",
    "heading_2",
    "heading_3",
    "bulleted_list_item",
    "numbered_list_item",
    "quote",
    "callout",
    "code",
  ];

  for (const t of richTextTypes) {
    if (block.type === t && block[t]) {
      const blockContent = block[t] as { rich_text?: NotionRichText[] };
      return (blockContent.rich_text ?? [])
        .map((rt: NotionRichText) => rt.plain_text ?? "")
        .join("");
    }
  }
  return "";
}

function markdownToNotionBlocks(markdown: string): object[] {
  const lines = markdown.split("\n");
  const blocks: object[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("## ")) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ type: "text", text: { content: trimmed.slice(3) } }],
        },
      });
    } else if (trimmed.startsWith("# ")) {
      blocks.push({
        object: "block",
        type: "heading_1",
        heading_1: {
          rich_text: [{ type: "text", text: { content: trimmed.slice(2) } }],
        },
      });
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [{ type: "text", text: { content: trimmed.slice(2) } }],
        },
      });
    } else if (/^\d+\.\s/.test(trimmed)) {
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: {
          rich_text: [
            {
              type: "text",
              text: { content: trimmed.replace(/^\d+\.\s/, "") },
            },
          ],
        },
      });
    } else {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: trimmed } }],
        },
      });
    }
  }

  return blocks;
}

export class NotionClient {
  private client: Client;
  private parentPageId: string;

  constructor() {
    const apiKey = process.env.NOTION_API_KEY;
    const parentPageId = process.env.NOTION_PARENT_PAGE_ID;

    if (!apiKey || !parentPageId) {
      throw new Error("Missing NOTION_API_KEY or NOTION_PARENT_PAGE_ID");
    }

    this.client = new Client({ auth: apiKey });
    this.parentPageId = parentPageId;
  }

  async searchPages(query: string): Promise<NotionPage[]> {
    const response = await this.client.search({
      query,
      filter: { property: "object", value: "page" },
      page_size: MAX_PAGES,
    });

    const pages: NotionPage[] = [];

    for (const result of response.results.slice(0, MAX_PAGES)) {
      if (result.object !== "page") continue;

      // Extract title
      const page = result as {
        id: string;
        url: string;
        properties?: {
          title?: { title?: NotionRichText[] };
          Name?: { title?: NotionRichText[] };
        };
      };

      const titleProp = page.properties?.title ?? page.properties?.Name;
      const title =
        (titleProp?.title ?? []).map((t) => t.plain_text ?? "").join("") ||
        "Untitled";

      // Fetch first N blocks for excerpt
      let excerpt = "";
      try {
        const blocksResponse = await this.client.blocks.children.list({
          block_id: page.id,
          page_size: BLOCKS_PER_PAGE,
        });

        excerpt = blocksResponse.results
          .map((b) => extractPlainText(b as NotionBlock))
          .filter(Boolean)
          .join(" ")
          .slice(0, EXCERPT_MAX_CHARS);
      } catch {
        // Non-fatal if we can't fetch blocks
      }

      pages.push({ id: page.id, title, url: page.url, excerpt });
    }

    return pages;
  }

  /**
   * Fetch ALL pages accessible to the integration — used for RAG indexing.
   * Paginates automatically up to MAX_INDEX_PAGES.
   */
  async getAllPages(): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    let cursor: string | undefined = undefined;

    while (pages.length < MAX_INDEX_PAGES) {
      const response = await this.client.search({
        filter: { property: "object", value: "page" },
        page_size: 50,
        ...(cursor ? { start_cursor: cursor } : {}),
      });

      for (const result of response.results) {
        if (result.object !== "page") continue;

        const page = result as {
          id: string;
          url: string;
          properties?: {
            title?: { title?: NotionRichText[] };
            Name?:  { title?: NotionRichText[] };
          };
        };

        const titleProp = page.properties?.title ?? page.properties?.Name;
        const title =
          (titleProp?.title ?? []).map((t) => t.plain_text ?? "").join("") ||
          "Untitled";

        let excerpt = "";
        try {
          const blocksResponse = await this.client.blocks.children.list({
            block_id: page.id,
            page_size: BLOCKS_PER_PAGE,
          });
          excerpt = blocksResponse.results
            .map((b) => extractPlainText(b as NotionBlock))
            .filter(Boolean)
            .join(" ")
            .slice(0, EXCERPT_MAX_CHARS);
        } catch {
          // non-fatal
        }

        pages.push({ id: page.id, title, url: page.url, excerpt });
      }

      if (!response.has_more || !response.next_cursor) break;
      cursor = response.next_cursor;
    }

    return pages;
  }

  /**
   * Fetch only pages edited after `since`.
   * Uses Notion's last_edited_time filter — one cheap API call.
   * Returns [] immediately if nothing changed.
   */
  async getPagesSince(since: Date): Promise<NotionPage[]> {
    const sinceISO = since.toISOString();
    const pages: NotionPage[] = [];
    let cursor: string | undefined = undefined;

    while (true) {
      const response = await this.client.search({
        filter:     { property: "object", value: "page" },
        sort:       { direction: "descending", timestamp: "last_edited_time" },
        page_size:  50,
        ...(cursor ? { start_cursor: cursor } : {}),
      });

      let reachedOld = false;

      for (const result of response.results) {
        if (result.object !== "page") continue;

        const page = result as {
          id:              string;
          url:             string;
          last_edited_time: string;
          properties?: {
            title?: { title?: NotionRichText[] };
            Name?:  { title?: NotionRichText[] };
          };
        };

        // Results are sorted newest-first — stop once we hit pages older than `since`
        if (new Date(page.last_edited_time) <= since) {
          reachedOld = true;
          break;
        }

        const titleProp = page.properties?.title ?? page.properties?.Name;
        const title =
          (titleProp?.title ?? []).map((t) => t.plain_text ?? "").join("") || "Untitled";

        let excerpt = "";
        try {
          const blocksResponse = await this.client.blocks.children.list({
            block_id:  page.id,
            page_size: BLOCKS_PER_PAGE,
          });
          excerpt = blocksResponse.results
            .map((b) => extractPlainText(b as NotionBlock))
            .filter(Boolean)
            .join(" ")
            .slice(0, EXCERPT_MAX_CHARS);
        } catch {
          // non-fatal
        }

        pages.push({ id: page.id, title, url: page.url, excerpt });
      }

      if (reachedOld || !response.has_more || !response.next_cursor) break;
      cursor = response.next_cursor;
    }

    return pages;
  }

  /**
   * Update an existing page by ID — replaces all content.
   * Preferred over upsertPage when the page ID is already known.
   */
  async updatePageById(pageId: string, markdownContent: string): Promise<{ id: string; url: string }> {
    // Delete all existing blocks (paginate to handle >100 blocks)
    let cursor: string | undefined;
    do {
      const resp = await this.client.blocks.children.list({
        block_id:   pageId,
        page_size:  100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      await Promise.all(
        resp.results.map((b) =>
          this.client.blocks.delete({ block_id: (b as { id: string }).id }).catch(() => {})
        )
      );
      cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
    } while (cursor);

    // Append new content in batches of 100
    const blocks = markdownToNotionBlocks(markdownContent);
    for (let i = 0; i < blocks.length; i += 100) {
      // @ts-expect-error Notion SDK type mismatch
      await this.client.blocks.children.append({ block_id: pageId, children: blocks.slice(i, i + 100) });
    }

    const page = await this.client.pages.retrieve({ page_id: pageId }) as { id: string; url: string };
    console.log(`[notion] ✓ Updated existing page: ${page.url}`);
    return { id: page.id, url: page.url };
  }

  /**
   * Find existing page by title, update it if found, create new one if not.
   * Pass knownPageId to skip the search entirely and update directly by ID.
   */
  async upsertPage(
    title:         string,
    markdownContent: string,
    knownPageId?:  string
  ): Promise<{ id: string; url: string; created: boolean }> {
    // Fast path — update by stored ID (no search needed)
    if (knownPageId) {
      console.log(`[notion] Updating page by stored ID ${knownPageId}…`);
      try {
        const result = await this.updatePageById(knownPageId, markdownContent);
        return { ...result, created: false };
      } catch (err) {
        // Page may have been deleted — fall through to search/create
        console.warn(`[notion] updatePageById failed (${(err as Error).message}), falling back to search`);
      }
    }

    // Search for existing page with this exact title
    const existing = await this.searchPages(title);
    const match    = existing.find((p) => p.title === title);

    if (match) {
      console.log(`[notion] Found existing page by title "${title}" — updating…`);
      const result = await this.updatePageById(match.id, markdownContent);
      return { ...result, created: false };
    }

    const result = await this.createPage(title, markdownContent);
    return { ...result, created: true };
  }

  async createPage(title: string, markdownContent: string): Promise<{ id: string; url: string }> {
    const blocks = markdownToNotionBlocks(markdownContent);

    // Notion API allows max 100 blocks per create call
    const firstBatch = blocks.slice(0, 100);

    const response = await this.client.pages.create({
      parent: { page_id: this.parentPageId },
      properties: {
        title: {
          title: [{ type: "text", text: { content: title } }],
        },
      },
      // @ts-expect-error Notion SDK type mismatch for children
      children: firstBatch,
    });

    // Append remaining blocks if any
    if (blocks.length > 100) {
      const remaining = blocks.slice(100);
      await this.client.blocks.children.append({
        block_id: response.id,
        // @ts-expect-error Notion SDK type mismatch for children
        children: remaining,
      });
    }

    const page = response as { id: string; url: string };
    return { id: page.id, url: page.url };
  }
}
