/**
 * AI-generated test cases for a GitHub issue.
 * Generates structured test cases with:
 * - Description
 * - curl command
 * - Expected status code
 * - Expected response fields
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export interface TestCase {
  name:           string;
  description:    string;
  curl:           string;
  method:         string;
  path:           string;
  url:            string;
  body?:          string;
  headers:        Record<string, string>;
  expectedStatus: number;
  expectedFields: string[];   // JSON paths to verify e.g. ["$.success", "$.data[0].salary"]
}

export interface TestSuite {
  issueNumber: number;
  title:       string;
  baseUrl:     string;
  cases:       TestCase[];
}

// ── Generate structured test cases ───────────────────────────────────────────

export async function generateTestSuite(
  issueNumber: number,
  title:       string
): Promise<TestSuite> {
  const owner    = process.env.GITHUB_OWNER;
  const repo     = process.env.GITHUB_REPO;
  const token    = process.env.GITHUB_TOKEN;
  const baseUrl  = process.env.SERVICE_BASE_URL ?? "https://spring-boot-with-ai.onrender.com";

  // Fetch PR diff for better context
  let issueBody = "";
  let prDiff    = "";

  if (owner && repo && token) {
    try {
      const issueResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
        { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" } }
      );
      if (issueResp.ok) {
        const data = await issueResp.json() as { body?: string };
        issueBody = data.body ?? "";
      }

      // Get associated PR
      const prsResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls?state=all&per_page=5`,
        { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" } }
      );
      if (prsResp.ok) {
        const prs = await prsResp.json() as Array<{ title: string; number: number; body?: string }>;
        const pr  = prs.find((p) => p.title.includes(`#${issueNumber}`) || (p.body ?? "").includes(`#${issueNumber}`));
        if (pr) {
          const diffResp = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}/files`,
            { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" } }
          );
          if (diffResp.ok) {
            const files = await diffResp.json() as Array<{ filename: string; patch?: string }>;
            prDiff = files
              .filter((f) => f.filename.endsWith(".java") || f.filename.endsWith(".ts"))
              .map((f) => `File: ${f.filename}\n${(f.patch ?? "").slice(0, 500)}`)
              .join("\n\n")
              .slice(0, 2000);
          }
        }
      }
    } catch {
      // proceed without context
    }
  }

  const systemPrompt = `You are a senior QA engineer. Generate structured API test cases as JSON.

Output ONLY valid JSON (no markdown) in this exact format:
{
  "cases": [
    {
      "name": "short test name",
      "description": "what this tests",
      "method": "GET|POST|PATCH|DELETE",
      "path": "/api/endpoint",
      "body": null or "{ \\"key\\": \\"value\\" }",
      "headers": { "Content-Type": "application/json" },
      "expectedStatus": 200,
      "expectedFields": ["$.success", "$.data.id", "$.data.fieldName"]
    }
  ]
}

CRITICAL RULES:
- This API wraps all responses as {"success": true/false, "data": {...}, "message": "..."}
- ALWAYS use $.data.fieldName NOT $.fieldName for response fields (e.g. $.data.id, $.data.gender)
- For list responses use $.data[0].fieldName
- For error responses check $.success = false, do NOT check $.data fields
- Generate 4-6 test cases: happy path, edge cases, validation error (400/404)
- For GET/PATCH/DELETE tests that need an ID, use path /api/employee/emp_123 as placeholder — the runner will replace it with a real ID from a prior POST
- For Spring Boot apps common paths: /api/employee, /api/salary, /api/department
- Single employee GET: GET /api/employee/{id} — use path /api/employee/emp_123 (runner replaces with real ID)
- expectedFields use JSONPath syntax — be precise about the nested structure
- Always order tests: POST (creates) first, then GET/PATCH/DELETE so IDs can be chained`;

  const userContent = `Feature: ${title}

${issueBody ? `Issue description:\n${issueBody}\n\n` : ""}${prDiff ? `Code changes:\n${prDiff}` : ""}

Base URL: ${baseUrl}

Generate test cases for this feature.`;

  const msg = await client.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 1500,
    system:     systemPrompt,
    messages:   [{ role: "user", content: userContent }],
  });

  const block = msg.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");

  const raw     = block.text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  const parsed  = JSON.parse(raw) as { cases: Array<Omit<TestCase, "curl" | "url">> };

  // Unique run token — appended to emails so re-runs never hit duplicate errors
  const runToken = Date.now().toString(36).slice(-5);

  // Build full test cases with curl commands + unique emails
  const cases: TestCase[] = parsed.cases.map((c) => {
    const uniqueBody = makeEmailsUnique(c.body ?? null, runToken);
    const url  = `${baseUrl}${c.path ?? ""}`;
    const curl = buildCurl(c.method, url, uniqueBody, c.headers ?? {});
    return { ...c, body: uniqueBody ?? c.body, url, curl };
  });

  return { issueNumber, title, baseUrl, cases };
}

// ── Execute test suite ────────────────────────────────────────────────────────

export interface TestResult {
  name:         string;
  passed:       boolean;
  status:       number;
  expectedStatus: number;
  response:     string;
  curl:         string;
  error?:       string;
  failReason?:  string;
}

export async function executeTestSuite(suite: TestSuite): Promise<TestResult[]> {
  const results: TestResult[] = [];
  // Capture IDs from POST/PUT responses so GET/PATCH/DELETE tests can reuse them
  const capturedIds: Record<string, string> = {};

  for (const tc of suite.cases) {
    // Replace placeholder IDs with captured real IDs from previous responses
    const resolved = resolveTestCase(tc, capturedIds);
    // Pass captured ID into the test case for smarter list assertions
    if (capturedIds["lastId"]) {
      (resolved as TestCase & { _capturedId?: string })._capturedId = capturedIds["lastId"];
    }
    const result   = await runSingleTest(resolved);

    // Capture IDs from successful create responses for chaining
    if (result.passed && ["POST", "PUT"].includes(tc.method) && result.response) {
      try {
        const json = JSON.parse(result.response);
        const id   = extractId(json);
        if (id) {
          capturedIds["lastId"] = id;
          capturedIds[`id_${results.length}`] = id;
          console.log(`[testRunner] Captured ID from ${tc.name}: ${id}`);
        }
      } catch { /* non-JSON — ignore */ }
    }

    results.push(result);
    await new Promise((r) => setTimeout(r, 600));
  }

  return results;
}

/** Replace placeholder IDs in URL/body with real captured IDs */
function resolveTestCase(tc: TestCase, ids: Record<string, string>): TestCase {
  if (Object.keys(ids).length === 0) return tc;

  const lastId = ids["lastId"];
  if (!lastId) return tc;

  // Replace fake placeholder IDs like emp_123, emp_456, 1, 123 in path
  const resolvedPath = tc.path.replace(
    /\/(emp_\w+|[0-9a-fA-F]{24}|id_placeholder|\btest[-_]?\w*id\b)/i,
    `/${lastId}`
  );
  const resolvedUrl = `${tc.url.split(tc.path)[0]}${resolvedPath}`;

  // Also replace in body if present
  const resolvedBody = tc.body
    ? tc.body.replace(/(emp_\w+|id_placeholder)/g, lastId)
    : tc.body;

  return { ...tc, path: resolvedPath, url: resolvedUrl, body: resolvedBody };
}

/** Extract the ID from a typical wrapped API response like {success, data: {id}} */
function extractId(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;

  // {success, data: {id: ...}}
  if (obj["data"] && typeof obj["data"] === "object") {
    const data = obj["data"] as Record<string, unknown>;
    const id   = data["id"] ?? data["_id"] ?? data["employeeId"];
    if (id) return String(id);
  }
  // flat {id: ...}
  const id = obj["id"] ?? obj["_id"];
  if (id) return String(id);

  return null;
}

async function runSingleTest(tc: TestCase): Promise<TestResult> {
  try {
    const fetchOpts: RequestInit = {
      method:  tc.method,
      headers: { "Content-Type": "application/json", ...tc.headers },
    };

    if (tc.body && ["POST", "PUT", "PATCH"].includes(tc.method)) {
      fetchOpts.body = tc.body;
    }

    const resp     = await fetch(tc.url, fetchOpts);
    const rawBody  = await resp.text();
    let responsePreview = rawBody.slice(0, 300);

    // Verify expected fields
    let passed     = resp.status === tc.expectedStatus;
    let failReason = "";

    if (!passed) {
      failReason = `Expected status ${tc.expectedStatus}, got ${resp.status}`;
    } else if (tc.expectedFields.length > 0) {
      try {
        const json      = JSON.parse(rawBody);
        const capturedId = (tc as TestCase & { _capturedId?: string })._capturedId;

        for (const field of tc.expectedFields) {
          // For list responses: if field is $.data[0].X and we have a captured ID,
          // find OUR employee in the list instead of blindly checking index 0
          if (field.match(/\$\.data\[0\]\./) && capturedId && Array.isArray((json as Record<string,unknown>)["data"])) {
            const list = (json as Record<string, unknown[]>)["data"];
            const entry = list.find((e) => {
              const obj = e as Record<string, unknown>;
              return obj["id"] === capturedId || obj["_id"] === capturedId;
            });
            if (!entry) {
              // fallback — check any entry in the list
              const subField = field.replace(/\$\.data\[0\]\./, "");
              const anyHas   = list.some((e) => (e as Record<string,unknown>)[subField] !== undefined);
              if (!anyHas) { passed = false; failReason = `Missing field: ${field} (checked all ${list.length} entries)`; break; }
            } else {
              const subField = field.replace(/\$\.data\[0\]\./, "");
              if ((entry as Record<string,unknown>)[subField] === undefined) {
                passed = false; failReason = `Missing field: ${field} on created employee`; break;
              }
            }
            continue;
          }

          if (!resolveJsonPath(json, field)) {
            passed     = false;
            failReason = `Missing field: ${field}`;
            break;
          }
        }
      } catch {
        // non-JSON response — just check status
      }
    }

    return {
      name:           tc.name,
      passed,
      status:         resp.status,
      expectedStatus: tc.expectedStatus,
      response:       responsePreview,
      curl:           tc.curl,
      failReason,
    };
  } catch (err) {
    return {
      name:           tc.name,
      passed:         false,
      status:         0,
      expectedStatus: tc.expectedStatus,
      response:       "",
      curl:           tc.curl,
      error:          err instanceof Error ? err.message : String(err),
      failReason:     `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Format results for Slack ──────────────────────────────────────────────────

export function formatTestResults(suite: TestSuite, results: TestResult[]): string {
  const passed = results.filter((r) => r.passed).length;
  const total  = results.length;
  const allOk  = passed === total;

  const lines: string[] = [
    `${allOk ? "✅" : "⚠️"} *Test Results for #${suite.issueNumber}: ${suite.title}*`,
    `${passed}/${total} tests passed`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
  ];

  for (const r of results) {
    const icon = r.passed ? "✅" : "❌";
    lines.push(`\n${icon} *${r.name}*`);
    lines.push(`\`\`\`${r.curl}\`\`\``);
    lines.push(`Status: \`${r.status}\` (expected \`${r.expectedStatus}\`)`);

    if (r.response) {
      const preview = r.response.length > 150 ? r.response.slice(0, 150) + "..." : r.response;
      lines.push(`Response: \`${preview}\``);
    }

    if (!r.passed && r.failReason) {
      lines.push(`⚠️ _${r.failReason}_`);
    }
  }

  lines.push(`\n━━━━━━━━━━━━━━━━━━━━━━━━`);
  if (allOk) {
    lines.push(`🎉 All tests passed! Type \`close ${suite.issueNumber}\` to close the ticket.`);
  } else {
    lines.push(`Some tests failed. Fix the issues or type \`close ${suite.issueNumber}\` to close anyway.`);
  }

  return lines.join("\n");
}

export function formatTestSuitePreview(suite: TestSuite): string {
  const lines: string[] = [
    `🧪 *Test Plan for #${suite.issueNumber}: ${suite.title}*`,
    `📡 Base URL: \`${suite.baseUrl}\``,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
  ];

  for (let i = 0; i < suite.cases.length; i++) {
    const tc = suite.cases[i];
    lines.push(`\n*${i + 1}. ${tc.name}*`);
    lines.push(`_${tc.description}_`);
    lines.push(`\`\`\`${tc.curl}\`\`\``);
    lines.push(`Expected: \`${tc.expectedStatus}\` · Check: ${tc.expectedFields.join(", ") || "status only"}`);
  }

  lines.push(`\n━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Reply *run tests* to execute all, or *close ${suite.issueNumber}* to skip testing.`);

  return lines.join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Traverse a JSONPath expression like $.data.id or $.data[0].salary.
 * Returns true if the path exists and has a non-undefined value.
 */
function resolveJsonPath(json: unknown, path: string): boolean {
  // Strip leading $. or $
  const clean  = path.replace(/^\$\.?/, "");
  if (!clean)   return json !== undefined;

  const parts  = clean.split(/\.|\[(\d+)\]/).filter(Boolean);
  let   current: unknown = json;

  for (const part of parts) {
    if (current === null || current === undefined) return false;
    if (typeof current === "object") {
      const index = /^\d+$/.test(part) ? parseInt(part, 10) : undefined;
      if (index !== undefined && Array.isArray(current)) {
        current = current[index];
      } else {
        current = (current as Record<string, unknown>)[part];
      }
    } else {
      return false;
    }
  }

  return current !== undefined;
}

function buildCurl(method: string, url: string, body: string | null, headers: Record<string, string>): string {
  const parts = [`curl -s -X ${method} "${url}"`];

  for (const [k, v] of Object.entries(headers)) {
    parts.push(`  -H "${k}: ${v}"`);
  }

  if (body) {
    // Escape single quotes in body so the shell doesn't break
    const safeBody = body.replace(/'/g, `'\\''`);
    parts.push(`  -d '${safeBody}'`);
  }

  return parts.join(" \\\n");
}

/** Append a unique run token to every email in a JSON body string to avoid 409 duplicates */
function makeEmailsUnique(body: string | null, token: string): string | null {
  if (!body) return body;
  return body.replace(
    /"email"\s*:\s*"([^"@]+)@([^"]+)"/g,
    (_: string, local: string, domain: string) => `"email": "${local}_${token}@${domain}"`
  );
}

// Legacy export for backward compatibility
export async function generateTestCases(issueNumber: number, title: string): Promise<string> {
  const suite = await generateTestSuite(issueNumber, title);
  return formatTestSuitePreview(suite);
}
