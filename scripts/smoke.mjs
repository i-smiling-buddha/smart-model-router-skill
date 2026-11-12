#!/usr/bin/env node
/**
 * Dependency-free smoke test of an INSTALLED smr (no vitest — runs on Node 20).
 * Uses SMR_BIN=<path to smr.mjs> if set, otherwise the global `smr` on PATH.
 *   node scripts/smoke.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const win = process.platform === "win32";
const bin = process.env.SMR_BIN;
const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

function smr(args, opts = {}) {
  const r = bin
    ? spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", ...opts })
    : spawnSync(win ? ["smr", ...args.map(quote)].join(" ") : "smr", win ? [] : args, { encoding: "utf8", shell: win, ...opts });
  if (r.error) throw r.error;
  return r;
}

const steps = [];
const step = (name, fn) => steps.push([name, fn]);

step("version", () => assert.match(smr(["--version"]).stdout.trim(), /^\d+\.\d+\.\d+/));
step("route", () => assert.equal(JSON.parse(smr(["route", "fix typo in README", "--host", "claude-code", "--json"]).stdout).decision.hostModel, "haiku"));
for (const host of ["claude-code", "opencode", "codex"]) {
  step(`init ${host} + doctor`, () => {
    const dir = mkdtempSync(join(tmpdir(), "smr-smoke-"));
    assert.equal(smr(["init", host, dir]).status, 0);
    const d = JSON.parse(smr(["doctor", "--json"], { cwd: dir }).stdout);
    const fails = d.checks.filter((c) => c.level === "fail");
    assert.deepEqual(fails, [], JSON.stringify(fails));
  });
}
step("task lifecycle", () => {
  const dir = mkdtempSync(join(tmpdir(), "smr-smoke-"));
  const t = JSON.parse(smr(["task", "start", "add a dark mode toggle", "--json"], { cwd: dir }).stdout);
  smr(["task", "attempt", t.taskId, "--model", "sonnet", "--fail"], { cwd: dir });
  const e = JSON.parse(smr(["task", "attempt", t.taskId, "--model", "sonnet", "--fail", "--json"], { cwd: dir }).stdout);
  assert.equal(e.next.action, "escalate");
});
step("mcp", () => {
  const input = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n";
  const r = smr(["mcp"], { input, cwd: mkdtempSync(join(tmpdir(), "smr-smoke-")) });
  assert.ok(JSON.parse(r.stdout.trim().split(/\r?\n/)[0]).result.tools.length >= 12);
});
step("bench --simulate", () => {
  const r = JSON.parse(smr(["bench", "--simulate", "--json"], { cwd: mkdtempSync(join(tmpdir(), "smr-smoke-")) }).stdout);
  assert.equal(r.simulated, true);
});

let failed = 0;
for (const [name, fn] of steps) {
  try { fn(); console.log(`✓ ${name}`); } catch (e) { failed++; console.log(`✗ ${name}\n  ${e.message}`); }
}
console.log(`\n${steps.length - failed}/${steps.length} smoke checks passed on Node ${process.versions.node} (${process.platform})`);
process.exit(failed ? 1 : 0);
