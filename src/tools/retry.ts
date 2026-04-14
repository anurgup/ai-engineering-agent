/**
 * retry.ts — Generic retry utility with exponential backoff.
 * Used by GitHub, Anthropic, and Voyage AI callers.
 */

const TRANSIENT_PATTERNS = [
  /rate.?limit/i,
  /429/,
  /503/,
  /504/,
  /502/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /network/i,
  /timeout/i,
  /socket hang up/i,
  /fetch failed/i,
  /connect ECONNREFUSED/i,
];

export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERNS.some((p) => p.test(msg));
}

export interface RetryOptions {
  maxAttempts?: number;   // default 3
  baseDelayMs?: number;   // default 1000ms
  maxDelayMs?:  number;   // default 15000ms
  label?:       string;   // for logging
  retryIf?:     (err: unknown) => boolean; // default: isTransientError
}

export async function withRetry<T>(
  fn:   () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs  = 15_000,
    label       = "operation",
    retryIf     = isTransientError,
  } = opts;

  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast      = attempt === maxAttempts;
      const shouldRetry = retryIf(err);

      if (isLast || !shouldRetry) throw err;

      const jitter    = Math.random() * 500;
      const delay     = Math.min(baseDelayMs * Math.pow(2, attempt - 1) + jitter, maxDelayMs);
      const errMsg    = err instanceof Error ? err.message : String(err);
      console.warn(`[retry] ${label} attempt ${attempt}/${maxAttempts} failed: ${errMsg}. Retrying in ${Math.round(delay)}ms…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastErr;
}

/** Wraps a promise with a timeout. Throws if it takes longer than ms. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`TIMEOUT: ${label} exceeded ${ms / 1000}s`)),
      ms
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err);  }
    );
  });
}
