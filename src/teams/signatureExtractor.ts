/**
 * Extract method / function signatures from source files.
 *
 * Returns only the signature line (not the body), so a 400-line Java class
 * becomes ~15 lines ≈ 40 tokens instead of 400 tokens.
 *
 * Supported: Java, Python, TypeScript/JavaScript
 */

export interface FileSignatures {
  path: string;
  language: string;
  signatures: string[];
}

/**
 * Extract signatures from a source file.
 * `path` is used to infer language when not provided.
 */
export function extractSignatures(path: string, content: string): FileSignatures {
  const lang = inferLanguage(path);
  const signatures = lang === "java"
    ? extractJava(content)
    : lang === "python"
    ? extractPython(content)
    : extractTypeScript(content);

  return { path, language: lang, signatures };
}

/**
 * Format a list of FileSignatures into a compact string for prompt injection.
 * ~40 tokens per file on average.
 */
export function formatSignatures(files: FileSignatures[]): string {
  return files
    .map((f) => {
      const sigs = f.signatures.slice(0, 20).join("\n  "); // cap at 20 signatures
      return `// ${f.path}\n  ${sigs}`;
    })
    .join("\n\n");
}

// ── Language detection ────────────────────────────────────────────────────────

function inferLanguage(filePath: string): "java" | "python" | "typescript" {
  if (filePath.endsWith(".java"))                  return "java";
  if (filePath.endsWith(".py"))                    return "python";
  if (filePath.endsWith(".ts") || filePath.endsWith(".js") || filePath.endsWith(".tsx"))
                                                   return "typescript";
  return "typescript"; // default fallback
}

// ── Java ──────────────────────────────────────────────────────────────────────

const JAVA_METHOD_RE =
  /^\s*(public|private|protected|static|final|\s)+[\w<>\[\]?,\s]+\s+(\w+)\s*\([^)]*\)\s*(throws\s+[\w,\s]+)?\s*\{/gm;

const JAVA_CLASS_RE =
  /^\s*(public|private|protected|abstract|final|\s)*(class|interface|enum)\s+(\w+)/gm;

function extractJava(content: string): string[] {
  const results: string[] = [];

  let m: RegExpExecArray | null;

  // Class / interface declarations
  JAVA_CLASS_RE.lastIndex = 0;
  while ((m = JAVA_CLASS_RE.exec(content)) !== null) {
    results.push(m[0].trim().replace(/\s+/g, " "));
  }

  // Method signatures (strip the opening brace)
  JAVA_METHOD_RE.lastIndex = 0;
  while ((m = JAVA_METHOD_RE.exec(content)) !== null) {
    const sig = m[0].trim().replace(/\s*\{$/, "").replace(/\s+/g, " ");
    if (!sig.includes("//") && sig.length < 200) {
      results.push(sig);
    }
  }

  return results;
}

// ── Python ────────────────────────────────────────────────────────────────────

const PYTHON_DEF_RE = /^\s*(async\s+)?def\s+\w+\s*\([^)]*\)\s*(->[\w\[\], |"']+)?:/gm;
const PYTHON_CLASS_RE = /^\s*class\s+\w+(\s*\([^)]*\))?\s*:/gm;

function extractPython(content: string): string[] {
  const results: string[] = [];

  let m: RegExpExecArray | null;

  PYTHON_CLASS_RE.lastIndex = 0;
  while ((m = PYTHON_CLASS_RE.exec(content)) !== null) {
    results.push(m[0].trim().replace(/\s+/g, " "));
  }

  PYTHON_DEF_RE.lastIndex = 0;
  while ((m = PYTHON_DEF_RE.exec(content)) !== null) {
    results.push(m[0].trim().replace(/\s+/g, " ").replace(/:$/, ""));
  }

  return results;
}

// ── TypeScript / JavaScript ───────────────────────────────────────────────────

const TS_FUNCTION_RE =
  /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+\w+\s*(<[^>]*>)?\s*\([^)]*\)(\s*:\s*[\w<>\[\]|, "'.?]+)?/gm;

const TS_ARROW_RE =
  /^\s*(export\s+)?(const|let)\s+(\w+)\s*=\s*(async\s+)?\([^)]*\)(\s*:\s*[\w<>\[\]|, "'.?]+)?\s*=>/gm;

const TS_CLASS_RE =
  /^\s*(export\s+)?(abstract\s+)?class\s+\w+(\s+extends\s+\w+)?(\s+implements\s+[\w,\s]+)?/gm;

const TS_INTERFACE_RE = /^\s*(export\s+)?interface\s+\w+/gm;

function extractTypeScript(content: string): string[] {
  const results: string[] = [];

  let m: RegExpExecArray | null;

  for (const re of [TS_CLASS_RE, TS_INTERFACE_RE, TS_FUNCTION_RE, TS_ARROW_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      const sig = m[0].trim().replace(/\s+/g, " ");
      if (sig.length < 200) results.push(sig);
    }
  }

  return results;
}
