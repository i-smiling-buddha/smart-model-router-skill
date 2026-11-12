# Installing Smart Model Router

## Requirements

- **Node.js 20 or newer.** Node 22.5+ is recommended: it has the built-in SQLite used for the
  execution log. On older versions SMR falls back to a JSON file automatically.
- One of: Claude Code, OpenCode, Codex, any MCP host — or none (CLI / HTTP / `smr exec`).
- API keys are **only** needed for `smr exec`, `smr bench` (real runs) and `--llm`
  classification. Hosts like Claude Code use their own login.

## Windows

1. Install Node.js if you don't have it (PowerShell):

   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```

   Close and reopen the terminal afterwards.

2. Install SMR — **from a clone** of the repository:

   ```powershell
   git clone https://github.com/i-smiling-buddha/smart-model-router-skill
   cd smart-model-router-skill
   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
   ```

   **or from a release** (once one is published on the Releases page), without cloning:

   ```powershell
   npm install -g https://github.com/i-smiling-buddha/smart-model-router-skill/releases/latest/download/smart-model-router-skill.tgz
   ```

3. Check it:

   ```powershell
   smr --version
   smr doctor
   ```

### Windows notes

- **MCP configs use `cmd /c`.** MCP hosts start servers without a shell, and npm's global `smr`
  on Windows is a `.cmd` file. `smr init` detects Windows and writes
  `"command": "cmd", "args": ["/c", "smr", "mcp"]` for you. If you copied configs from macOS/Linux,
  re-run `smr init … --platform windows` in an empty folder and copy the MCP part, or run
  `smr doctor` — it flags the problem.
- **`smr` not found after install:** npm's global folder (`npm prefix -g`) isn't on your PATH.
  Add it under *Settings → System → About → Advanced system settings → Environment Variables →
  Path*, then open a new terminal.
- **Execution policy errors:** run scripts with `powershell -ExecutionPolicy Bypass -File …` as
  shown; you don't need to change the system policy.

## macOS / Linux

```bash
git clone https://github.com/i-smiling-buddha/smart-model-router-skill
cd smart-model-router-skill
sh scripts/install.sh
```

or `npm install -g <release .tgz URL>` as above. If `npm install -g` needs `sudo` on Linux, use a
user-level prefix instead: `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to PATH.

## Add SMR to a project

```bash
cd your-project
smr init claude-code      # or opencode / codex — run several if you use several hosts
smr doctor
```

Add `.smr/` to your project's `.gitignore` — it's your local execution log.

## Optional: API keys

Set only the ones you use (never commit them):

| Variable | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | `smr exec`, `smr bench`, `--llm` classification |
| `OPENAI_API_KEY` | `openai/…` models |
| `OPENROUTER_API_KEY` | `openrouter/…` models |
| `GEMINI_API_KEY` | `google/…` models |
| `OLLAMA_HOST` | local Ollama (default `http://localhost:11434`, no key) |

Windows (persists for new terminals): `setx ANTHROPIC_API_KEY "…"`.

## Developing SMR itself

```bash
npm ci
npm run build
npm test              # needs Node 22.12+ (test tooling); the CLI itself runs on Node 20+
npm link -w @smr/cli  # puts your dev build on PATH as `smr`
npm run release:pack  # builds release/smart-model-router-skill.tgz
```

## Uninstall

```bash
npm uninstall -g smart-model-router-skill
```

Then delete the SMR files from your projects (`.claude/agents/smr-*`, `.claude/skills/smart-model-router`,
`.opencode/agents/smr-*`, `.codex/agents/smr-*`, `.agents/skills/smart-model-router`, `smr.config.json`, `.smr/`)
and the `smr` entries in `.mcp.json`, `.claude/settings.json`, `opencode.json` and `.codex/config.toml`.
