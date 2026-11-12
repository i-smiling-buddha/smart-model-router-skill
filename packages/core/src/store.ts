import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { redactSecrets } from "./handoff.js";
import type { RoutingDecision, TaskCategory, TaskClassification } from "./types.js";

/**
 * Execution Log — every task, every attempt, every token.
 * Feeds retry management now and the Learning Engine (Phase 4) later.
 *
 * Backend: built-in `node:sqlite` when available (Node ≥ 22.5), otherwise a JSON file.
 * Default location: <project>/.smr/  (local-first: nothing leaves the machine)
 */

export type TaskStatus = "open" | "completed" | "failed" | "stopped";

export interface TaskRecord {
  id: string;
  text: string;
  category: TaskCategory;
  complexity: number;
  riskLevel: string;
  classification: TaskClassification;
  decision: RoutingDecision;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AttemptRow {
  id: number;
  taskId: string;
  modelId: string;
  passed: boolean;
  failureReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  costUnits?: number;
  durationMs?: number;
  createdAt: string;
}

export interface ModelStats {
  modelId: string;
  attempts: number;
  passes: number;
  passRate: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  costUnits: number;
}

export interface ExecutionStore {
  readonly backend: "sqlite" | "json" | "memory";
  createTask(text: string, classification: TaskClassification, decision: RoutingDecision): TaskRecord;
  getTask(id: string): { task: TaskRecord; attempts: AttemptRow[] } | undefined;
  addAttempt(a: Omit<AttemptRow, "id" | "createdAt">): AttemptRow;
  setStatus(id: string, status: TaskStatus): void;
  listTasks(limit?: number): TaskRecord[];
  modelStats(): ModelStats[];
  categoryStats(): { category: TaskCategory; modelId: string; attempts: number; passRate: number }[];
  /** Per model × category × complexity — the Learning Engine's input. */
  performanceStats(): PerformanceRow[];
  /** Most recent attempts, oldest first. */
  listAttempts(limit?: number): AttemptRow[];
  cacheGet(key: string): string | undefined;
  cacheSet(key: string, value: string): void;
  close(): void;
}

export const newTaskId = () => "t_" + Date.now().toString(36) + randomBytes(3).toString("hex");
const now = () => new Date().toISOString();
/** Owner-only on POSIX (Windows ignores the mode; the folder lives in the user's project). */
const privateDir = (dir: string) => mkdirSync(dir, { recursive: true, mode: 0o700 });
const clean = (s: string | undefined) => (s === undefined ? undefined : redactSecrets(s));

/* ------------------------------------------------------------------ */
/* Shared aggregate logic                                              */
/* ------------------------------------------------------------------ */

function aggregateModels(attempts: AttemptRow[]): ModelStats[] {
  const by = new Map<string, ModelStats>();
  const known = new Set<string>();
  for (const a of attempts) {
    const s = by.get(a.modelId) ?? { modelId: a.modelId, attempts: 0, passes: 0, passRate: 0, inputTokens: 0, outputTokens: 0, costUsd: null, costUnits: 0 };
    s.attempts++;
    if (a.passed) s.passes++;
    s.inputTokens += a.inputTokens ?? 0;
    s.outputTokens += a.outputTokens ?? 0;
    s.costUnits += a.costUnits ?? 0;
    if (a.costUsd !== undefined) { s.costUsd = (s.costUsd ?? 0) + a.costUsd; known.add(a.modelId); }
    by.set(a.modelId, s);
  }
  for (const s of by.values()) {
    s.passRate = Math.round((s.passes / s.attempts) * 1000) / 1000;
    // USD is null when no attempt for this model had known pricing.
    if (!known.has(s.modelId)) s.costUsd = null;
    else s.costUsd = Math.round(s.costUsd! * 1e6) / 1e6;
  }
  return [...by.values()].sort((a, b) => b.attempts - a.attempts);
}

export interface PerformanceRow {
  modelId: string;
  category: TaskCategory;
  complexity: number;
  attempts: number;
  passes: number;
  /** Attempts that reported tokens (for averages). */
  tokenSamples: number;
  inputTokens: number;
  outputTokens: number;
}

function aggregatePerformance(tasks: { id: string; category: TaskCategory; complexity: number }[], attempts: AttemptRow[]): PerformanceRow[] {
  const meta = new Map(tasks.map((t) => [t.id, t]));
  const by = new Map<string, PerformanceRow>();
  for (const a of attempts) {
    const t = meta.get(a.taskId);
    if (!t) continue;
    const k = `${a.modelId}|${t.category}|${t.complexity}`;
    const r = by.get(k) ?? { modelId: a.modelId, category: t.category, complexity: t.complexity, attempts: 0, passes: 0, tokenSamples: 0, inputTokens: 0, outputTokens: 0 };
    r.attempts++;
    if (a.passed) r.passes++;
    if (a.inputTokens !== undefined || a.outputTokens !== undefined) {
      r.tokenSamples++;
      r.inputTokens += a.inputTokens ?? 0;
      r.outputTokens += a.outputTokens ?? 0;
    }
    by.set(k, r);
  }
  return [...by.values()];
}

function aggregateCategories(tasks: TaskRecord[], attempts: AttemptRow[]) {
  const cat = new Map(tasks.map((t) => [t.id, t.category]));
  const by = new Map<string, { category: TaskCategory; modelId: string; attempts: number; passes: number }>();
  for (const a of attempts) {
    const c = cat.get(a.taskId);
    if (!c) continue;
    const k = `${c}|${a.modelId}`;
    const s = by.get(k) ?? { category: c, modelId: a.modelId, attempts: 0, passes: 0 };
    s.attempts++;
    if (a.passed) s.passes++;
    by.set(k, s);
  }
  return [...by.values()].map(({ passes, ...s }) => ({ ...s, passRate: Math.round((passes / s.attempts) * 1000) / 1000 }));
}

/* ------------------------------------------------------------------ */
/* In-memory / JSON-file store                                         */
/* ------------------------------------------------------------------ */

interface JsonData { tasks: TaskRecord[]; attempts: AttemptRow[]; cache: Record<string, string> }

export class JsonStore implements ExecutionStore {
  readonly backend: "json" | "memory";
  private data: JsonData = { tasks: [], attempts: [], cache: {} };

  constructor(private readonly file?: string) {
    this.backend = file ? "json" : "memory";
    if (file && existsSync(file)) this.data = JSON.parse(readFileSync(file, "utf8"));
  }

  private save() {
    if (!this.file) return;
    privateDir(dirname(this.file));
    writeFileSync(this.file, JSON.stringify(this.data, null, 1));
  }

  createTask(text: string, classification: TaskClassification, decision: RoutingDecision): TaskRecord {
    text = redactSecrets(text);
    const t: TaskRecord = {
      id: newTaskId(), text, category: classification.category, complexity: classification.complexity,
      riskLevel: classification.riskLevel, classification, decision, status: "open", createdAt: now(), updatedAt: now(),
    };
    this.data.tasks.push(t);
    this.save();
    return t;
  }

  getTask(id: string) {
    const task = this.data.tasks.find((t) => t.id === id);
    return task ? { task, attempts: this.data.attempts.filter((a) => a.taskId === id) } : undefined;
  }

  addAttempt(a: Omit<AttemptRow, "id" | "createdAt">): AttemptRow {
    if (!this.data.tasks.some((t) => t.id === a.taskId)) throw new Error(`Unknown task id: ${a.taskId}`);
    const row: AttemptRow = { ...a, failureReason: clean(a.failureReason), id: this.data.attempts.length + 1, createdAt: now() };
    if (row.failureReason === undefined) delete row.failureReason;
    this.data.attempts.push(row);
    this.save();
    return row;
  }

  setStatus(id: string, status: TaskStatus) {
    const t = this.data.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`Unknown task id: ${id}`);
    t.status = status;
    t.updatedAt = now();
    this.save();
  }

  listTasks(limit = 20) { return [...this.data.tasks].reverse().slice(0, limit); }
  modelStats() { return aggregateModels(this.data.attempts); }
  categoryStats() { return aggregateCategories(this.data.tasks, this.data.attempts); }
  performanceStats() { return aggregatePerformance(this.data.tasks, this.data.attempts); }
  listAttempts(limit = 1000) { return this.data.attempts.slice(-limit); }
  cacheGet(key: string) { return this.data.cache[key]; }
  cacheSet(key: string, value: string) { this.data.cache[key] = value; this.save(); }
  close() {}
}

/* ------------------------------------------------------------------ */
/* SQLite store (node:sqlite)                                          */
/* ------------------------------------------------------------------ */

// Minimal typing for node:sqlite so we don't depend on @types versions.
interface Stmt { run(...a: unknown[]): { lastInsertRowid: number | bigint }; get(...a: unknown[]): any; all(...a: unknown[]): any[] }
interface Db { exec(sql: string): void; prepare(sql: string): Stmt; close(): void }

function loadSqlite(): (new (path: string) => Db) | undefined {
  // Silence node's one-time ExperimentalWarning for sqlite only.
  const original = process.emitWarning;
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    const msg = typeof w === "string" ? w : w.message;
    if (/SQLite/i.test(msg)) return;
    return (original as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    const req = createRequire(import.meta.url);
    return req("node:sqlite").DatabaseSync;
  } catch {
    return undefined;
  } finally {
    process.emitWarning = original;
  }
}

export class SqliteStore implements ExecutionStore {
  readonly backend = "sqlite" as const;
  private db: Db;

  constructor(file: string, Database: new (path: string) => Db) {
    if (file !== ":memory:") privateDir(dirname(file));
    this.db = new Database(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT NOT NULL, complexity INTEGER NOT NULL,
        risk_level TEXT NOT NULL, classification TEXT NOT NULL, decision TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
        model_id TEXT NOT NULL, passed INTEGER NOT NULL, failure_reason TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, cost_units REAL,
        duration_ms INTEGER, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id);
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
  }

  createTask(text: string, classification: TaskClassification, decision: RoutingDecision): TaskRecord {
    text = redactSecrets(text);
    const t: TaskRecord = {
      id: newTaskId(), text, category: classification.category, complexity: classification.complexity,
      riskLevel: classification.riskLevel, classification, decision, status: "open", createdAt: now(), updatedAt: now(),
    };
    this.db.prepare(`INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      t.id, t.text, t.category, t.complexity, t.riskLevel, JSON.stringify(classification), JSON.stringify(decision), t.status, t.createdAt, t.updatedAt,
    );
    return t;
  }

  private rowToTask(r: any): TaskRecord {
    return {
      id: r.id, text: r.text, category: r.category, complexity: r.complexity, riskLevel: r.risk_level,
      classification: JSON.parse(r.classification), decision: JSON.parse(r.decision), status: r.status,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  private rowToAttempt(r: any): AttemptRow {
    const o: AttemptRow = { id: Number(r.id), taskId: r.task_id, modelId: r.model_id, passed: !!r.passed, createdAt: r.created_at };
    if (r.failure_reason != null) o.failureReason = r.failure_reason;
    if (r.input_tokens != null) o.inputTokens = r.input_tokens;
    if (r.output_tokens != null) o.outputTokens = r.output_tokens;
    if (r.cost_usd != null) o.costUsd = r.cost_usd;
    if (r.cost_units != null) o.costUnits = r.cost_units;
    if (r.duration_ms != null) o.durationMs = r.duration_ms;
    return o;
  }

  getTask(id: string) {
    const r = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
    if (!r) return undefined;
    const attempts = this.db.prepare(`SELECT * FROM attempts WHERE task_id = ? ORDER BY id`).all(id).map((x) => this.rowToAttempt(x));
    return { task: this.rowToTask(r), attempts };
  }

  addAttempt(a: Omit<AttemptRow, "id" | "createdAt">): AttemptRow {
    if (!this.db.prepare(`SELECT 1 FROM tasks WHERE id = ?`).get(a.taskId)) throw new Error(`Unknown task id: ${a.taskId}`);
    const createdAt = now();
    const res = this.db
      .prepare(`INSERT INTO attempts (task_id, model_id, passed, failure_reason, input_tokens, output_tokens, cost_usd, cost_units, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(a.taskId, a.modelId, a.passed ? 1 : 0, clean(a.failureReason) ?? null, a.inputTokens ?? null, a.outputTokens ?? null, a.costUsd ?? null, a.costUnits ?? null, a.durationMs ?? null, createdAt);
    const row: AttemptRow = { ...a, failureReason: clean(a.failureReason), id: Number(res.lastInsertRowid), createdAt };
    if (row.failureReason === undefined) delete row.failureReason;
    return row;
  }

  setStatus(id: string, status: TaskStatus) {
    this.db.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`).run(status, now(), id);
  }

  listTasks(limit = 20) {
    return this.db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(limit).map((r) => this.rowToTask(r));
  }

  private allAttempts() { return this.db.prepare(`SELECT * FROM attempts ORDER BY id`).all().map((r) => this.rowToAttempt(r)); }
  private allTasks() { return this.db.prepare(`SELECT * FROM tasks`).all().map((r) => this.rowToTask(r)); }
  modelStats() { return aggregateModels(this.allAttempts()); }
  categoryStats() { return aggregateCategories(this.allTasks(), this.allAttempts()); }
  performanceStats() {
    // Light query: only the columns learning needs (no classification/decision JSON).
    const meta = this.db.prepare(`SELECT id, category, complexity FROM tasks`).all() as { id: string; category: TaskCategory; complexity: number }[];
    return aggregatePerformance(meta, this.allAttempts());
  }
  listAttempts(limit = 1000) {
    return this.db.prepare(`SELECT * FROM attempts ORDER BY id DESC LIMIT ?`).all(limit).map((r) => this.rowToAttempt(r)).reverse();
  }
  cacheGet(key: string) { return this.db.prepare(`SELECT value FROM cache WHERE key = ?`).get(key)?.value; }
  cacheSet(key: string, value: string) {
    this.db.prepare(`INSERT INTO cache (key, value, created_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value, now());
  }
  close() { this.db.close(); }
}

/** Open the project's execution store: SQLite if possible, JSON otherwise. */
export function openStore(dir = join(process.cwd(), ".smr"), opts: { backend?: "sqlite" | "json" | "memory" } = {}): ExecutionStore {
  if (opts.backend === "memory") return new JsonStore();
  if (opts.backend !== "json") {
    const Database = loadSqlite();
    if (Database) return new SqliteStore(join(dir, "smr.db"), Database);
    if (opts.backend === "sqlite") throw new Error("node:sqlite is not available (needs Node ≥ 22.5). Use the JSON backend.");
  }
  return new JsonStore(join(dir, "log.json"));
}

export { loadSqlite as _loadSqlite };
