import type { BenchmarkReport } from "./benchmark.js";
import { estimateSavings, learningReport } from "./insights.js";
import { ModelRegistry } from "./registry.js";
import type { ExecutionStore, TaskStatus } from "./store.js";

/**
 * Dashboard — one self-contained HTML file (no CDN, no network), light + dark mode.
 *
 *   Usage        stat tiles: tasks, success rate, tokens, savings vs always-best
 *   Cost         cost by model (bars)
 *   Model intel  pass rate by model × category (heatmap, values printed in cells)
 *   Learning     prior → observed → blended success
 *   Benchmarks   latest run: success and cost per strategy (two charts, one measure each)
 *   Routing      recent tasks with status (icon + label, never color alone)
 */

export interface DashboardData {
  generatedAt: string;
  store: string;
  totals: { tasks: number; completed: number; attempts: number; inputTokens: number; outputTokens: number };
  savings: ReturnType<typeof estimateSavings>;
  models: { modelId: string; attempts: number; passRate: number; tokens: number; cost: number; costUnit: "usd" | "cost-units" }[];
  heatmap: { models: string[]; categories: string[]; cells: { modelId: string; category: string; attempts: number; passRate: number }[] };
  learning: ReturnType<typeof learningReport>;
  recent: { id: string; status: TaskStatus; category: string; complexity: number; routedTo: string; text: string; createdAt: string }[];
  benchmark?: Pick<BenchmarkReport, "suite" | "finishedAt" | "simulated" | "strategies" | "comparisons">;
}

export function buildDashboardData(store: ExecutionStore, registry = new ModelRegistry(), benchmarks: BenchmarkReport[] = []): DashboardData {
  const models = store.modelStats();
  const cats = store.categoryStats();
  const tasks = store.listTasks(100_000);
  const allPriced = models.length > 0 && models.every((m) => m.costUsd !== null);
  const latest = [...benchmarks].sort((a, b) => a.finishedAt.localeCompare(b.finishedAt)).pop();
  return {
    generatedAt: new Date().toISOString(),
    store: store.backend,
    totals: {
      tasks: tasks.length,
      completed: tasks.filter((t) => t.status === "completed").length,
      attempts: models.reduce((s, m) => s + m.attempts, 0),
      inputTokens: models.reduce((s, m) => s + m.inputTokens, 0),
      outputTokens: models.reduce((s, m) => s + m.outputTokens, 0),
    },
    savings: estimateSavings(store, registry),
    models: models.map((m) => ({
      modelId: m.modelId, attempts: m.attempts, passRate: m.passRate, tokens: m.inputTokens + m.outputTokens,
      cost: allPriced ? m.costUsd ?? 0 : m.costUnits, costUnit: allPriced ? "usd" : "cost-units",
    })),
    heatmap: {
      models: [...new Set(cats.map((c) => c.modelId))].sort(),
      categories: [...new Set(cats.map((c) => c.category))].sort(),
      cells: cats,
    },
    learning: learningReport(store, registry),
    recent: tasks.slice(0, 25).map((t) => ({
      id: t.id, status: t.status, category: t.category, complexity: t.complexity,
      routedTo: t.decision.selectedModel, text: t.text.slice(0, 140), createdAt: t.createdAt,
    })),
    benchmark: latest && { suite: latest.suite, finishedAt: latest.finishedAt, simulated: latest.simulated, strategies: latest.strategies, comparisons: latest.comparisons },
  };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const short = (id: string) => id.replace(/^[^/]+\//, "");
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-IN");
const fmtCost = (n: number, unit: string) => (unit === "usd" ? `$${n.toFixed(4)}` : `${n.toFixed(4)} units`);
const pct = (p: number) => `${Math.round(p * 100)}%`;

// Sequential blue ramp (light→dark) from the reference palette, for pass-rate cells.
const SEQ = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95"];
const seqStep = (p: number) => Math.min(SEQ.length - 1, Math.max(0, Math.round(p * (SEQ.length - 1))));
// Light mode: low = pale (recedes into the light surface), high = dark.
// Dark mode: the ramp is stepped the other way, so low values recede into the dark surface.
// Ink flips with the background so every printed value stays readable.
const seqCss = () => {
  const n = SEQ.length - 1;
  const light = SEQ.map((c, i) => `.s${i}{background:${c};color:${i >= 6 ? "#ffffff" : "#0b0b0b"}}`).join("");
  const darkRules = SEQ.map((_, i) => `.s${i}{background:${SEQ[n - i]};color:${n - i >= 6 ? "#ffffff" : "#0b0b0b"}}`);
  const dark = darkRules.map((r) => `.viz-root table.heat td${r}`).join("");
  return `table.heat td${light.replace(/\}\.s/g, "}table.heat td.s")}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) ${dark.replace(/\}\.viz-root/g, "}:root:where(:not([data-theme=\"light\"])) .viz-root")}}
${dark.replace(/\.viz-root/g, ':root[data-theme="dark"] .viz-root')}`;
};

const STATUS: Record<TaskStatus, { icon: string; label: string; cls: string }> = {
  completed: { icon: "✓", label: "Completed", cls: "good" },
  open: { icon: "●", label: "Open", cls: "warning" },
  stopped: { icon: "■", label: "Stopped", cls: "serious" },
  failed: { icon: "✗", label: "Failed", cls: "critical" },
};

/** Horizontal bar chart, single series, value labels at bar ends, hover tooltip. */
function hbars(rows: { label: string; value: number; display: string; tip: string }[], title: string, desc: string): string {
  if (!rows.length) return `<p class="empty">No data yet.</p>`;
  const max = Math.max(...rows.map((r) => r.value), 1e-9);
  const rowH = 30;
  const labelW = 170;
  const plotW = 360;
  const h = rows.length * rowH + 8;
  const bars = rows.map((r, i) => {
    const w = Math.max(6, (r.value / max) * plotW);
    const y = i * rowH + 6;
    return `<g class="mark" data-tip="${esc(r.tip)}">
      <rect class="hit" x="0" y="${y - 3}" width="${labelW + plotW + 110}" height="${rowH}" fill="transparent"/>
      <text x="${labelW - 8}" y="${y + 13}" text-anchor="end" class="axis-label">${esc(r.label)}</text>
      <path d="M${labelW},${y} h${w - 4} a4,4 0 0 1 4,4 v10 a4,4 0 0 1 -4,4 h-${w - 4} z" class="bar"/>
      <text x="${labelW + w + 6}" y="${y + 13}" class="value-label">${esc(r.display)}</text>
    </g>`;
  }).join("");
  return `<svg role="img" aria-label="${esc(title)}: ${esc(desc)}" viewBox="0 0 ${labelW + plotW + 110} ${h}" width="100%" style="max-width:${labelW + plotW + 110}px">
    <line x1="${labelW}" y1="0" x2="${labelW}" y2="${h}" class="baseline"/>${bars}</svg>`;
}

function heatmap(d: DashboardData["heatmap"]): string {
  if (!d.cells.length) return `<p class="empty">No attempts logged yet.</p>`;
  const cell = new Map(d.cells.map((c) => [`${c.modelId}|${c.category}`, c]));
  const head = d.categories.map((c) => `<th scope="col">${esc(c)}</th>`).join("");
  const body = d.models.map((m) => `<tr><th scope="row">${esc(short(m))}</th>${d.categories.map((c) => {
    const x = cell.get(`${m}|${c}`);
    if (!x) return `<td class="na" aria-label="no data">–</td>`;
    return `<td class="mark s${seqStep(x.passRate)}" data-tip="${esc(`${short(m)} · ${c}: ${pct(x.passRate)} pass over ${x.attempts} attempt${x.attempts === 1 ? "" : "s"}`)}">${pct(x.passRate)}<small>n=${x.attempts}</small></td>`;
  }).join("")}</tr>`).join("");
  return `<div class="scroll"><table class="heat"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <p class="note">Pass rate per attempt — the closer a cell is to the background colour, the lower the rate. n = attempts.</p>`;
}

export function renderDashboard(d: DashboardData): string {
  const unit = d.models[0]?.costUnit ?? d.savings.unit;
  const success = d.totals.tasks ? d.totals.completed / d.totals.tasks : 0;
  const tiles = [
    { label: "Tasks routed", value: fmtInt(d.totals.tasks), sub: `${fmtInt(d.totals.attempts)} attempts` },
    { label: "Completed", value: pct(success), sub: `${d.totals.completed} of ${d.totals.tasks}` },
    { label: "Tokens", value: fmtInt(d.totals.inputTokens + d.totals.outputTokens), sub: `${fmtInt(d.totals.inputTokens)} in · ${fmtInt(d.totals.outputTokens)} out` },
    {
      label: "Saved vs always-best",
      value: d.savings.attemptsWithTokens ? `${d.savings.savedPct}%` : "–",
      sub: d.savings.attemptsWithTokens ? `vs ${short(d.savings.baselineModel)} on the same tokens` : "needs attempts with token counts",
    },
  ].map((t) => `<div class="tile"><div class="tile-label">${esc(t.label)}</div><div class="tile-value">${esc(t.value)}</div><div class="tile-sub">${esc(t.sub)}</div></div>`).join("");

  const costChart = hbars(
    [...d.models].sort((a, b) => b.cost - a.cost).map((m) => ({
      label: short(m.modelId), value: m.cost, display: fmtCost(m.cost, m.costUnit),
      tip: `${short(m.modelId)}: ${fmtCost(m.cost, m.costUnit)} · ${fmtInt(m.tokens)} tokens · ${m.attempts} attempts · ${pct(m.passRate)} pass`,
    })),
    "Cost by model", "estimated cost per model",
  );

  const learningRows = d.learning.slice(0, 40).map((r) => `<tr><td>${esc(short(r.modelId))}</td><td>${esc(r.category)}</td><td class="num">${r.complexity}</td><td class="num">${r.attempts}</td><td class="num">${pct(r.priorP)}</td><td class="num">${pct(r.observedPassRate)}</td><td class="num strong">${pct(r.blendedP)}</td><td class="num">${r.avgOutputTokens !== undefined ? fmtInt(r.avgOutputTokens) : "–"}</td></tr>`).join("");

  let bench = `<p class="empty">No benchmark yet. Run <code>smr bench</code> (or <code>smr bench --simulate</code> for an offline demo).</p>`;
  if (d.benchmark) {
    const b = d.benchmark;
    const bunit = b.strategies.every((s) => s.costUsd !== null) ? "usd" : "cost-units";
    const successChart = hbars(b.strategies.map((s) => ({ label: short(s.strategy), value: s.successRate, display: pct(s.successRate), tip: `${s.strategy}: ${s.passed}/${s.cases} passed, ${s.retries} retries` })), "Benchmark success rate", "success rate per strategy");
    const costChart2 = hbars(b.strategies.map((s) => { const v = bunit === "usd" ? s.costUsd ?? 0 : s.costUnits; return { label: short(s.strategy), value: v, display: fmtCost(v, bunit), tip: `${s.strategy}: ${fmtCost(v, bunit)} · ${fmtInt(s.inputTokens + s.outputTokens)} tokens` }; }), "Benchmark cost", "total cost per strategy");
    const verdicts = b.comparisons.map((c) => `<li><span class="status ${c.verdict === "pass" ? "good" : "critical"}">${c.verdict === "pass" ? "✓ Pass" : "✗ Fail"}</span> SMR vs <b>${esc(short(c.baseline))}</b>: ${esc(c.why)} (success ${c.successDeltaPts >= 0 ? "+" : ""}${c.successDeltaPts} pts, cost ${c.costDeltaPct >= 0 ? "+" : ""}${c.costDeltaPct}%)</li>`).join("");
    bench = `${b.simulated ? `<p class="banner">⚠ Simulated run — demo data, not a real measurement.</p>` : ""}
      <p class="note">Suite <b>${esc(b.suite)}</b> · ${esc(new Date(b.finishedAt).toLocaleString())}</p>
      <ul class="verdicts">${verdicts}</ul>
      <div class="two"><figure><figcaption>Success rate</figcaption>${successChart}</figure><figure><figcaption>Total cost</figcaption>${costChart2}</figure></div>`;
  }

  const recent = d.recent.map((t) => { const s = STATUS[t.status]; return `<tr><td><span class="status ${s.cls}">${s.icon} ${s.label}</span></td><td>${esc(short(t.routedTo))}</td><td>${esc(t.category)}/c${t.complexity}</td><td class="task">${esc(t.text)}</td><td class="muted">${esc(new Date(t.createdAt).toLocaleString())}</td></tr>`; }).join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Smart Model Router — Dashboard</title>
<style>
.viz-root{color-scheme:light;--surface-0:#f4f3f0;--surface-1:#fcfcfb;--border:#e3e2dc;--text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#7a7974;--series-1:#2a78d6;--grid:#e3e2dc;
  --good:#0ca30c;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b;--good-text:#006300;--critical-text:#b02a2a}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;--surface-0:#121211;--surface-1:#1a1a19;--border:#2e2e2b;--text-primary:#f0efec;--text-secondary:#c3c2b7;--text-muted:#94938b;--series-1:#3987e5;--grid:#383835;--good-text:#4cc94c;--critical-text:#f08080}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;--surface-0:#121211;--surface-1:#1a1a19;--border:#2e2e2b;--text-primary:#f0efec;--text-secondary:#c3c2b7;--text-muted:#94938b;--series-1:#3987e5;--grid:#383835;--good-text:#4cc94c;--critical-text:#f08080}
*{box-sizing:border-box}body{margin:0}
.viz-root{background:var(--surface-0);color:var(--text-primary);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Devanagari",sans-serif;min-height:100vh;padding:24px}
header{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;max-width:1180px;margin:0 auto 16px}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:0 0 12px}.muted,.note{color:var(--text-muted);font-size:12px}
main{max-width:1180px;margin:0 auto;display:grid;gap:16px}
section{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:16px 18px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.tile{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.tile-label{color:var(--text-secondary);font-size:12px}.tile-value{font-size:28px;font-weight:600;margin:2px 0}.tile-sub{color:var(--text-muted);font-size:12px}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}figure{margin:0}figcaption{font-size:12px;color:var(--text-secondary);margin-bottom:6px}
svg .bar{fill:var(--series-1)}svg .baseline{stroke:var(--grid);stroke-width:1}
svg .axis-label{fill:var(--text-secondary);font-size:12px}svg .value-label{fill:var(--text-primary);font-size:12px}
svg .mark:hover .bar{opacity:.85}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:6px 8px;text-align:left;border-bottom:1px solid var(--border)}
th{color:var(--text-secondary);font-weight:500}td.num{text-align:right;font-variant-numeric:tabular-nums}td.strong{font-weight:600}
td.task{max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.scroll{overflow-x:auto}
table.heat{border-collapse:separate;border-spacing:2px;width:auto}table.heat td{min-width:84px;text-align:center;border:0;border-radius:4px;font-weight:600;font-variant-numeric:tabular-nums}
table.heat td small{display:block;font-weight:400;font-size:10px;opacity:.8}table.heat td.na{color:var(--text-muted);background:transparent}
table.heat th{border:0;white-space:nowrap}
.status{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:10px;border:1px solid var(--border);white-space:nowrap}
.status.good{color:var(--good-text);border-color:var(--good)}.status.critical{color:var(--critical-text);border-color:var(--critical)}
.status.warning{color:var(--text-primary);border-color:var(--warning)}.status.serious{color:var(--text-primary);border-color:var(--serious)}
.verdicts{list-style:none;padding:0;margin:0 0 12px}.verdicts li{margin:6px 0}
.banner{background:color-mix(in srgb,var(--warning) 18%,var(--surface-1));border:1px solid var(--warning);border-radius:8px;padding:6px 10px;font-size:13px}
.empty{color:var(--text-muted)}code{font-size:12px}
#tip{position:fixed;pointer-events:none;background:var(--text-primary);color:var(--surface-1);font-size:12px;padding:6px 8px;border-radius:6px;max-width:320px;display:none;z-index:9}
${seqCss()}
button.theme{background:none;border:1px solid var(--border);color:var(--text-secondary);border-radius:8px;padding:3px 10px;cursor:pointer}
</style></head>
<body><div class="viz-root">
<header><h1>Smart Model Router</h1><div class="muted">Generated ${esc(new Date(d.generatedAt).toLocaleString())} · store: ${esc(d.store)} · <button class="theme" type="button" onclick="toggleTheme()">Toggle theme</button></div></header>
<main>
<div class="tiles">${tiles}</div>
<section><h2>Cost by model</h2>${costChart}<p class="note">${unit === "usd" ? "USD from registry pricing." : "Relative cost units — set pricing in the registry to see USD."} Savings compare actual cost with running the same tokens on the strongest model.</p></section>
<section><h2>Pass rate by model × category</h2>${heatmap(d.heatmap)}</section>
<section><h2>Benchmarks</h2>${bench}</section>
<section><h2>Learning engine</h2>${learningRows ? `<div class="scroll"><table><thead><tr><th>Model</th><th>Category</th><th>Cx</th><th>Attempts</th><th>Prior</th><th>Observed</th><th>Blended</th><th>Avg out tokens</th></tr></thead><tbody>${learningRows}</tbody></table></div><p class="note">Blended = what the router uses now: prior × k + passes over k + attempts.</p>` : `<p class="empty">The router learns from logged attempts — nothing logged yet.</p>`}</section>
<section><h2>Recent tasks</h2>${recent ? `<div class="scroll"><table><thead><tr><th>Status</th><th>Model</th><th>Kind</th><th>Task</th><th>When</th></tr></thead><tbody>${recent}</tbody></table></div>` : `<p class="empty">No tasks yet.</p>`}</section>
</main><div id="tip" role="tooltip"></div></div>
<script>
(function(){var tip=document.getElementById('tip');
document.querySelectorAll('[data-tip]').forEach(function(el){
 el.addEventListener('mousemove',function(e){tip.textContent=el.getAttribute('data-tip');tip.style.display='block';
  var x=e.clientX+14,y=e.clientY+14;if(x+330>innerWidth)x=e.clientX-330;tip.style.left=x+'px';tip.style.top=y+'px';});
 el.addEventListener('mouseleave',function(){tip.style.display='none';});});})();
function toggleTheme(){var r=document.documentElement;var dark=r.getAttribute('data-theme')==='dark'||(!r.getAttribute('data-theme')&&matchMedia('(prefers-color-scheme: dark)').matches);r.setAttribute('data-theme',dark?'light':'dark');}
</script></body></html>`;
}
