/**
 * Context Manager — compact Task Handoff between models.
 *
 * Rule: requirements, security constraints and user decisions are NEVER dropped,
 * even when everything else is trimmed. Secrets are redacted before anything leaves.
 */

export interface TaskHandoff {
  task: string;
  originalRequirement: string;
  previousWork?: string;
  relevantFiles?: string[];
  snippets?: { path: string; code: string }[];
  findings?: string[];
  completed?: string[];
  remaining?: string[];
  /** Always kept. */
  constraints?: string[];
  /** Always kept. */
  userDecisions?: string[];
  expectedOutput?: string;
  failureHistory?: { modelId: string; reason: string }[];
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /((?:api[_-]?key|secret|password|token)\s*[:=]\s*)(["']?)[^\s"']{6,}\2/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, (match, prefix?: string) =>
      typeof prefix === "string" && /[:=]\s*$/.test(prefix) ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return out;
}

const SENSITIVE_FILE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|credentials.*|secrets?\..*)$/i;
export const isSensitiveFile = (p: string) => SENSITIVE_FILE.test(p);

/** Approx chars per token used for budgeting (good enough for English + code). */
const CHARS_PER_TOKEN = 4;

export function buildHandoff(h: TaskHandoff, opts: { maxTokens?: number } = {}): string {
  const maxChars = (opts.maxTokens ?? 3_000) * CHARS_PER_TOKEN;
  const list = (items?: string[]) => (items?.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)");

  // Mandatory part — never trimmed.
  const head = [
    `## Task Handoff`,
    `**Task:** ${h.task}`,
    `**Original requirement:** ${h.originalRequirement}`,
    `**Constraints (must keep):**\n${list(h.constraints)}`,
    h.userDecisions?.length ? `**User decisions (must keep):**\n${list(h.userDecisions)}` : "",
    h.expectedOutput ? `**Expected output:** ${h.expectedOutput}` : "",
  ].filter(Boolean);

  // Optional part — trimmed from the end if over budget.
  const files = (h.relevantFiles ?? []).filter((f) => !isSensitiveFile(f));
  const optional = [
    h.previousWork ? `**Previous work:** ${h.previousWork}` : "",
    h.completed?.length ? `**Completed:**\n${list(h.completed)}` : "",
    h.remaining?.length ? `**Remaining:**\n${list(h.remaining)}` : "",
    files.length ? `**Relevant files:**\n${list(files)}` : "",
    h.failureHistory?.length ? `**Earlier attempts that failed:**\n${list(h.failureHistory.map((f) => `${f.modelId}: ${f.reason}`))}` : "",
    h.findings?.length ? `**Findings:**\n${list(h.findings)}` : "",
    ...(h.snippets ?? []).filter((s) => !isSensitiveFile(s.path)).map((s) => `**${s.path}:**\n\`\`\`\n${s.code}\n\`\`\``),
  ].filter(Boolean);

  const parts = [...head];
  let size = parts.join("\n\n").length;
  let dropped = 0;
  for (const block of optional) {
    if (size + block.length + 2 > maxChars) { dropped++; continue; }
    parts.push(block);
    size += block.length + 2;
  }
  if (dropped) parts.push(`_(${dropped} lower-priority block(s) omitted to fit the token budget — ask if you need them.)_`);
  return redactSecrets(parts.join("\n\n"));
}
