import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verificationLevelsFor } from "./classifier.js";
import { redactSecrets } from "./handoff.js";
import type { TaskCategory, TaskClassification, VerificationLevel } from "./types.js";

/**
 * Quality Evaluator — "did the work actually succeed?"
 *
 *   static     → typecheck / lint / build          (runs commands)
 *   functional → tests                             (runs commands, only if static passed)
 *   semantic   → requirement checklist             (returned for the host model / human to tick)
 *
 * Effort matches the task: a README gets only the semantic checklist, never a full test suite.
 */

export interface CheckCommand {
  name: string;
  command: string;
  level: Exclude<VerificationLevel, "semantic">;
  timeoutMs?: number;
  /** Only run for these categories (default: all that need this level). */
  categories?: TaskCategory[];
}

export interface CheckResult {
  name: string;
  level: CheckCommand["level"];
  command: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Tail of combined stdout/stderr, secrets redacted. */
  output: string;
}

export interface EvaluationResult {
  passed: boolean;
  levelsRequested: VerificationLevel[];
  results: CheckResult[];
  skipped: { name: string; reason: string }[];
  semanticChecklist: string[];
  /** Short text to put into a retry/escalation handoff. */
  failureSummary?: string;
}

export type CommandRunner = (cmd: string, cwd: string, timeoutMs: number) => Promise<{ exitCode: number | null; output: string; timedOut: boolean }>;

const OUTPUT_TAIL = 2_000;
const DEFAULT_TIMEOUT = 5 * 60_000;

export const shellRunner: CommandRunner = (cmd, cwd, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, env: process.env });
    let output = "";
    let timedOut = false;
    const onData = (d: Buffer) => {
      output += d.toString();
      if (output.length > OUTPUT_TAIL * 4) output = output.slice(-OUTPUT_TAIL * 2);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.on("error", (e) => { output += `\n${e.message}`; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output, timedOut });
    });
  });

/** Detect sensible checks from package.json scripts (typecheck/lint/build → static, test → functional). */
export function detectChecks(cwd: string): CheckCommand[] {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) {
    if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "pytest.ini"))) {
      return [{ name: "pytest", command: "python -m pytest -q", level: "functional" }];
    }
    return [];
  }
  let scripts: Record<string, string> = {};
  try { scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {}; } catch { return []; }
  const checks: CheckCommand[] = [];
  const pm = existsSync(join(cwd, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(cwd, "yarn.lock")) ? "yarn" : "npm run";
  for (const name of ["typecheck", "type-check", "lint", "build"]) {
    if (scripts[name]) checks.push({ name, command: `${pm} ${name}`, level: "static" });
  }
  if (scripts.test && !/no test specified/.test(scripts.test)) {
    checks.push({ name: "test", command: pm === "npm run" ? "npm test" : `${pm} test`, level: "functional" });
  }
  return checks;
}

export async function evaluate(
  task: TaskClassification,
  opts: { cwd?: string; checks?: CheckCommand[]; runner?: CommandRunner; levels?: VerificationLevel[] } = {},
): Promise<EvaluationResult> {
  const cwd = opts.cwd ?? process.cwd();
  const levels = opts.levels ?? verificationLevelsFor(task);
  const checks = opts.checks ?? detectChecks(cwd);
  const runner = opts.runner ?? shellRunner;
  const results: CheckResult[] = [];
  const skipped: EvaluationResult["skipped"] = [];

  for (const level of ["static", "functional"] as const) {
    const forLevel = checks.filter((c) => c.level === level);
    if (!levels.includes(level)) {
      forLevel.forEach((c) => skipped.push({ name: c.name, reason: `${level} checks not needed for this task` }));
      continue;
    }
    if (level === "functional" && results.some((r) => !r.passed)) {
      forLevel.forEach((c) => skipped.push({ name: c.name, reason: "static checks failed — fix those first" }));
      continue;
    }
    for (const c of forLevel) {
      if (c.categories && !c.categories.includes(task.category)) {
        skipped.push({ name: c.name, reason: `not configured for ${task.category}` });
        continue;
      }
      const t0 = Date.now();
      const r = await runner(c.command, cwd, c.timeoutMs ?? DEFAULT_TIMEOUT);
      results.push({
        name: c.name,
        level,
        command: c.command,
        passed: r.exitCode === 0 && !r.timedOut,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        durationMs: Date.now() - t0,
        output: redactSecrets(r.output.slice(-OUTPUT_TAIL)),
      });
    }
  }

  const semanticChecklist = levels.includes("semantic")
    ? [...task.successCriteria, "Output matches the user's original requirement", "No unrequested changes"]
    : [];
  const failed = results.filter((r) => !r.passed);
  return {
    passed: failed.length === 0,
    levelsRequested: levels,
    results,
    skipped,
    semanticChecklist,
    failureSummary: failed.length
      ? failed.map((f) => `${f.name} ${f.timedOut ? "timed out" : `exit ${f.exitCode}`}: ${lastLines(f.output, 15)}`).join("\n---\n")
      : undefined,
  };
}

function lastLines(s: string, n: number): string {
  // Drop npm/pnpm script echo lines ("> test", "> node ...") and blanks — pure noise for a model.
  return s.trimEnd().split(/\r?\n/).filter((l) => l.trim() && !/^> /.test(l)).slice(-n).join("\n");
}
