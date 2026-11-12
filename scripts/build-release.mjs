#!/usr/bin/env node
/**
 * Builds the publishable package in release/smart-model-router-skill/:
 *   dist/smr.mjs      — the whole CLI (core + server + zod) bundled into one file
 *   integrations/     — host templates used by `smr init`
 *   benchmarks/       — suites used by `smr bench`
 *   README / LICENSE / CHANGELOG / SECURITY
 * With --pack it also runs `npm pack` → release/smart-model-router-skill-<version>.tgz
 * and a stable copy release/smart-model-router-skill.tgz (for "latest" download links).
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "release", "smart-model-router-skill");

rmSync(join(root, "release"), { recursive: true, force: true });
mkdirSync(join(out, "dist"), { recursive: true });

await build({
  entryPoints: [join(root, "apps/cli/src/index.ts")],
  outfile: join(out, "dist/smr.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,
  sourcemap: false,
  legalComments: "eof",
  // The source's own "#!/usr/bin/env node" line is preserved by esbuild.
  banner: { js: 'import { createRequire as __smrCreateRequire } from "node:module"; const require = __smrCreateRequire(import.meta.url);' },
  define: { "process.env.SMR_VERSION": JSON.stringify(rootPkg.version) },
  logLevel: "warning",
});
chmodSync(join(out, "dist/smr.mjs"), 0o755);

for (const dir of ["integrations", "benchmarks", "docs"]) cpSync(join(root, dir), join(out, dir), { recursive: true });
for (const f of ["README.md", "README.hi.md", "LICENSE", "CHANGELOG.md", "SECURITY.md", "smr.registry.example.json"]) {
  if (existsSync(join(root, f))) copyFileSync(join(root, f), join(out, f));
}

const pkg = {
  name: "smart-model-router-skill",
  version: rootPkg.version,
  description: rootPkg.description,
  type: "module",
  bin: { smr: "dist/smr.mjs" },
  files: ["dist", "integrations", "benchmarks", "docs", "README.md", "README.hi.md", "LICENSE", "CHANGELOG.md", "SECURITY.md", "smr.registry.example.json"],
  engines: { node: ">=20" },
  keywords: rootPkg.keywords,
  repository: rootPkg.repository,
  homepage: rootPkg.homepage,
  bugs: rootPkg.bugs,
  author: rootPkg.author,
  license: rootPkg.license,
};
writeFileSync(join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
console.log(`built ${out} (v${pkg.version})`);

if (process.argv.includes("--pack")) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const file = execFileSync(npm, ["pack", "--pack-destination", join(root, "release")], { cwd: out, encoding: "utf8", shell: process.platform === "win32" })
    .trim().split(/\r?\n/).pop();
  copyFileSync(join(root, "release", file), join(root, "release", "smart-model-router-skill.tgz"));
  console.log(`packed release/${file} (+ release/smart-model-router-skill.tgz)`);
}
