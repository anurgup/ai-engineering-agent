/**
 * Voyage AI embedding wrapper — uses native fetch, no extra npm package needed.
 * Model: voyage-3-lite  (512 dimensions, fast, cheap)
 * Docs: https://docs.voyageai.com/reference/embeddings-api
 */

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL    = "voyage-3-lite";
const BATCH_SIZE      = 32; // Voyage API max per request

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
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
    throw new Error(
      "VOYAGE_API_KEY is not set. Get a free key at https://www.voyageai.com"
    );
  }

  const allVectors: number[][] = new Array(texts.length);

  // Process in batches to stay within API limits
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const response = await fetch(VOYAGE_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: VOYAGE_MODEL, input: batch }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Voyage AI API error ${response.status}: ${err}`);
    }

    const data = (await response.json()) as VoyageResponse;

    data.data.forEach((item) => {
      allVectors[i + item.index] = item.embedding;
    });
  }

  return allVectors;
}
