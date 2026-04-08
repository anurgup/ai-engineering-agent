/**
 * Voyage AI embedding wrapper — uses native fetch, no extra npm package needed.
 * Model: voyage-3-lite  (512 dimensions, fast, cheap)
 * Docs: https://docs.voyageai.com/reference/embeddings-api
 *
 * Rate limit handling:
 *   Free tier (no payment method): 3 RPM / 10K TPM
 *   On 429 → exponential backoff up to MAX_RETRIES
 */

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL   = "voyage-3-lite";
const BATCH_SIZE     = 32;   // Voyage API max per request
const MAX_RETRIES    = 5;
const BASE_DELAY_MS  = 20000; // 20s — enough to clear a 3 RPM window

interface VoyageResponse {
  data:  { embedding: number[]; index: number }[];
  usage: { total_tokens: number };
}

/** Embed a single string. Returns a 512-dim float array. */
export async function embedText(text: string): Promise<number[]> {
  const results = await embedBatch([text]);
  return results[0];
}

/** Embed multiple strings in batches. Returns one vector per input. */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error("VOYAGE_API_KEY is not set. Get a free key at https://www.voyageai.com");
  }

  const allVectors: number[][] = new Array(texts.length);

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    allVectors.splice(i, batch.length, ...(await fetchWithRetry(batch, apiKey, i)));
  }

  return allVectors;
}

async function fetchWithRetry(
  batch: string[],
  apiKey: string,
  offset: number
): Promise<number[][]> {
  let lastError: Error = new Error("Unknown error");

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(VOYAGE_API_URL, {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: VOYAGE_MODEL, input: batch }),
    });

    // Success
    if (response.ok) {
      const data = (await response.json()) as VoyageResponse;
      const vectors: number[][] = new Array(batch.length);
      data.data.forEach((item) => { vectors[item.index] = item.embedding; });
      return vectors;
    }

    const errText = await response.text();

    // Rate limited — wait and retry
    if (response.status === 429) {
      const waitMs = BASE_DELAY_MS * attempt;
      console.warn(
        `[embeddings] ⚠ Rate limited (429) — waiting ${waitMs / 1000}s before retry` +
        ` (attempt ${attempt}/${MAX_RETRIES})`
      );
      await sleep(waitMs);
      lastError = new Error(`Voyage AI rate limit: ${errText}`);
      continue;
    }

    // Other errors — don't retry
    throw new Error(`Voyage AI API error ${response.status}: ${errText}`);
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
