import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

/**
 * Host hooks — capture token usage automatically.
 *
 * Claude Code SubagentStop gives us `agent_type` and `agent_transcript_path` (JSONL).
 * Assistant lines in that transcript carry `message.model` and `message.usage`.
 */

export interface SubagentStopInput {
  hook_event_name?: string;
  agent_type?: string;
  agent_id?: string;
  agent_transcript_path?: string;
  transcript_path?: string;
  last_assistant_message?: string;
}

export interface TranscriptUsage {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  messages: number;
}

/** Sum usage from a Claude Code transcript (JSONL). Unknown / malformed lines are ignored. */
export function usageFromTranscript(jsonl: string): TranscriptUsage {
  const out: TranscriptUsage = { inputTokens: 0, outputTokens: 0, messages: 0 };
  const seen = new Set<string>();
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const msg = e?.message;
    const u = msg?.usage;
    if (!u || (e.type && e.type !== "assistant")) continue;
    // A streamed message can be written on several lines with the same id — count it once.
    const id = msg.id ?? e.uuid;
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    out.inputTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    out.outputTokens += u.output_tokens ?? 0;
    out.messages++;
    if (msg.model) out.model = msg.model;
  }
  return out;
}

/** Default SMR subagent → host model mapping (used if the transcript has no model field). */
export const SMR_AGENT_MODELS: Record<string, string> = {
  "smr-fast": "haiku",
  "smr-builder": "sonnet",
  "smr-architect": "opus",
};

export function readTranscript(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const p = path.startsWith("~") ? homedir() + path.slice(1) : path;
  return existsSync(p) ? readFileSync(p, "utf8") : undefined;
}
