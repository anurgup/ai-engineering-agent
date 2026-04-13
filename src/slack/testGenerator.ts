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
      "expectedFields": ["$.success", "$.data"]
    }
  ]
}

Rules:
- Generate 4-6 test cases covering: happy path, edge cases, validation errors
- Use realistic test data
- For Spring Boot apps, common paths are /api/employee, /api/salary etc.
- expectedFields use JSONPath syntax
- Include at least one negative test (400/404 response)`;

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

  // Build full test cases with curl commands
  const cases: TestCase[] = parsed.cases.map((c) => {
    const url  = `${baseUrl}${c.path ?? ""}`;
    const curl = buildCurl(c.method, url, c.body ?? null, c.headers ?? {});
    return { ...c, url, curl };
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

  for (const tc of suite.cases) {
    const result = await runSingleTest(tc);
    results.push(result);
    // Small delay between requests
    await new Promise((r) => setTimeout(r, 500));
  }

  return results;
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
        const json = JSON.parse(rawBody);
        for (const field of tc.expectedFields) {
          const key   = field.replace(/^\$\./, "").split(".")[0].replace(/\[.*\]/, "");
          if (json[key] === undefined) {
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

// Legacy export for backward compatibility
export async function generateTestCases(issueNumber: number, title: string): Promise<string> {
  const suite = await generateTestSuite(issueNumber, title);
  return formatTestSuitePreview(suite);
}
