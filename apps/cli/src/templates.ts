/**
 * On Windows, MCP hosts spawn commands without a shell, and npm's global "smr" is a .cmd shim —
 * so MCP configs must call it through cmd /c. Hook commands run in a shell and are left alone.
 */
export function adaptTemplate(rel: string, content: string, platform: string): string {
  if (platform !== "win32") return content;
  const p = rel.split("\\").join("/");
  if (p.endsWith(".mcp.json")) return content.replace(/"command": "smr",\s*"args": \["mcp"\]/, '"command": "cmd",\n      "args": ["/c", "smr", "mcp"]');
  if (p.endsWith("opencode.json")) return content.replace(/"command": \["smr", "mcp"\]/, '"command": ["cmd", "/c", "smr", "mcp"]');
  if (p.endsWith(".codex/config.toml")) return content.replace(/command = "smr"\s*\nargs = \["mcp"\]/, 'command = "cmd"\nargs = ["/c", "smr", "mcp"]');
  return content;
}
