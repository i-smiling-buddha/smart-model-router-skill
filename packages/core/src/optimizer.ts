import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isSensitiveFile, redactSecrets } from "./handoff.js";
import type { Observation } from "./learning.js";
import type { TaskClassification } from "./types.js";

/**
 * Token Optimizer — "minimum cost per successful task" starts with not sending junk.
 *
 *   packContext()      relevant-file selection, dedupe, compression, budgeted packing
 *                      with keyword windows for big files; sensitive files never included
 *   suggestMaxTokens() response-length control from history (or the complexity guess)
 *   estimateTokens()   cheap, dependency-free estimate (Devanagari/CJK count heavier)
 */

export interface ContextFile { path: string; content: string }

export interface PackedFile { path: string; content: string; tokens: number; score: number; truncated: boolean }

export interface PackResult {
  files: PackedFile[];
  dropped: { path: string; reason: string }[];
  tokensBefore: number;
  tokensAfter: number;
  savedPct: number;
  /** Ready-to-send markdown. */
  markdown: string;
}

export function estimateTokens(s: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) (s.charCodeAt(i) < 128 ? ascii++ : other++);
  return Math.ceil(ascii / 4 + other / 1.5);
}

const LONG_LINE = 400;

/** Lossless-in-meaning cleanup: trailing spaces, blank-line runs, minified/base64 blobs. */
export function compressText(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]{100,}/g, (m) => `[data-uri ${m.length} chars omitted]`)
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .map((l) => (l.length > LONG_LINE && !/\s/.test(l.slice(0, 200)) ? `${l.slice(0, 120)} … [${l.length - 120} chars omitted]` : l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const STOP = new Set("the a an and or to of in on for with this that from into is are be it as at by add make fix use using please can you want need should my our your all some then also just".split(" "));

export function keywords(task: string): string[] {
  const words = task
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\d]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w));
  return [...new Set(words)];
}

function relevance(f: ContextFile, kws: string[]): number {
  const path = f.path.toLowerCase();
  const body = f.content.toLowerCase();
  let s = 0;
  for (const k of kws) {
    if (path.includes(k)) s += 3;
    let hits = 0;
    for (let i = body.indexOf(k); i !== -1 && hits < 50; i = body.indexOf(k, i + k.length)) hits++;
    if (hits) s += 1 + Math.log2(1 + hits);
  }
  return Math.round(s * 100) / 100;
}

/** Keep the head of the file plus windows around keyword hits. */
function windows(content: string, kws: string[], budgetTokens: number, radius = 8, head = 20): string {
  const lines = content.split("\n");
  const keep = new Set<number>();
  for (let i = 0; i < Math.min(head, lines.length); i++) keep.add(i);
  lines.forEach((l, i) => {
    const low = l.toLowerCase();
    if (kws.some((k) => low.includes(k))) for (let j = Math.max(0, i - radius); j <= Math.min(lines.length - 1, i + radius); j++) keep.add(j);
  });
  const out: string[] = [];
  let last = -1;
  let used = 0;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const line = lines[i]!;
    const t = estimateTokens(line) + 1;
    if (used + t > budgetTokens) break;
    if (last !== -1 && i !== last + 1) out.push(`… [lines ${last + 2}-${i} omitted]`);
    out.push(line);
    used += t;
    last = i;
  }
  if (last < lines.length - 1) out.push(`… [lines ${last + 2}-${lines.length} omitted]`);
  return out.join("\n");
}

const IGNORED = /(^|[/\\])(node_modules|dist|build|out|\.git|\.next|coverage|\.smr|vendor|__pycache__)([/\\]|$)|\.(lock|png|jpe?g|gif|webp|ico|pdf|zip|gz|exe|dll|so|dylib|bin|woff2?|ttf|mp[34]|mov|db|sqlite)$|(^|[/\\])(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;

export function packContext(task: string, files: ContextFile[], budgetTokens = 8_000): PackResult {
  const kws = keywords(task);
  const dropped: PackResult["dropped"] = [];
  const seen = new Set<string>();
  let tokensBefore = 0;

  const candidates = files.flatMap((f) => {
    tokensBefore += estimateTokens(f.content);
    if (isSensitiveFile(f.path)) { dropped.push({ path: f.path, reason: "sensitive file — never sent" }); return []; }
    if (IGNORED.test(f.path)) { dropped.push({ path: f.path, reason: "generated / binary / lockfile" }); return []; }
    const h = createHash("sha1").update(f.content).digest("hex");
    if (seen.has(h)) { dropped.push({ path: f.path, reason: "duplicate content" }); return []; }
    seen.add(h);
    const content = redactSecrets(compressText(f.content));
    return [{ path: f.path, content, score: relevance({ path: f.path, content }, kws), tokens: estimateTokens(content) }];
  }).sort((a, b) => b.score - a.score || a.tokens - b.tokens);

  const packed: PackedFile[] = [];
  let used = 0;
  for (const c of candidates) {
    const left = budgetTokens - used;
    const overhead = estimateTokens(c.path) + 8;
    if (left <= overhead + 20) { dropped.push({ path: c.path, reason: "token budget exhausted" }); continue; }
    if (c.tokens + overhead <= left) {
      packed.push({ path: c.path, content: c.content, tokens: c.tokens, score: c.score, truncated: false });
      used += c.tokens + overhead;
    } else if (c.score > 0) {
      const w = windows(c.content, kws, left - overhead);
      const t = estimateTokens(w);
      packed.push({ path: c.path, content: w, tokens: t, score: c.score, truncated: true });
      used += t + overhead;
    } else {
      dropped.push({ path: c.path, reason: "not relevant and too large for remaining budget" });
    }
  }

  const markdown = packed.map((f) => `### ${f.path}${f.truncated ? " (relevant parts)" : ""}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n");
  const tokensAfter = estimateTokens(markdown);
  return {
    files: packed,
    dropped,
    tokensBefore,
    tokensAfter,
    savedPct: tokensBefore ? Math.max(0, Math.round((1 - tokensAfter / tokensBefore) * 1000) / 10) : 0,
    markdown,
  };
}

/** Read text files under a directory for packContext (skips ignored/binary/huge files). */
export function collectFiles(root: string, opts: { maxFiles?: number; maxBytesPerFile?: number; maxTotalBytes?: number } = {}): ContextFile[] {
  const maxFiles = opts.maxFiles ?? 400;
  const maxFile = opts.maxBytesPerFile ?? 200_000;
  const maxTotal = opts.maxTotalBytes ?? 3_000_000;
  const out: ContextFile[] = [];
  let total = 0;
  const walk = (dir: string) => {
    if (out.length >= maxFiles || total >= maxTotal) return;
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join("/");
      if (IGNORED.test(rel)) continue;
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (!st.isFile() || st.size > maxFile || total + st.size > maxTotal) continue;
      const buf = readFileSync(full);
      if (buf.subarray(0, 8000).includes(0)) continue; // binary
      out.push({ path: rel, content: buf.toString("utf8") });
      total += st.size;
      if (out.length >= maxFiles) return;
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** Response-length control: cap output tokens from what this kind of task really needs. */
export function suggestMaxTokens(task: TaskClassification, obs?: Observation): number {
  const base = obs?.avgOutputTokens ? obs.avgOutputTokens * 1.5 : task.estimatedOutputTokens * 1.25;
  return Math.round(Math.min(32_000, Math.max(512, base)));
}
