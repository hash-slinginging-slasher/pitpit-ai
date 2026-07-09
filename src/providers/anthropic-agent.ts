import { z } from 'zod';
import type { AgentConfig } from '../config.js';
import { localTools, type LocalTool, type AgentRunOptions, type AgentRunResult } from '../local-agent.js';
import type { AgentEvent, ChatMessage } from '../agent.js';
import { readClaudeOAuth } from './credentials.js';

/**
 * `anthropic-messages` transport for the cli/claude router. Drives our tool loop
 * against the Anthropic Messages API using the Claude Code subscription OAuth token
 * (resolved by credentials.readClaudeOAuth). Emits the same AgentEvent stream and
 * return shape as runAgent() so the CLI + web history work unchanged.
 *
 * OAuth (non-API-key) requests are only accepted when the first system block presents
 * the Claude Code identity, so we prepend it — see CLAUDE_CODE_IDENTITY below.
 */

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 8192;

/** Required first system block for Claude Code OAuth tokens. */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Default model when the id is just `cli/claude` (override with `cli/claude/<model-id>`). */
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5';

/** Resolve the wire model id from a `cli/claude[/<model>]` id. */
export function claudeModelFromId(model: string): string {
  const rest = model.replace(/^cli\/claude\/?/, '');
  return rest || DEFAULT_CLAUDE_MODEL;
}

/** Anthropic tool spec (name/description/input_schema) from our client tools. */
function anthropicToolSpecs() {
  return localTools().map((t) => ({
    name: t.function.name,
    description: t.function.description ?? '',
    input_schema: z.toJSONSchema(t.function.inputSchema as any, { target: 'draft-7' }),
  }));
}

/** Split our system prompt + chat history into Anthropic `system` blocks + `messages`. */
function toAnthropic(systemPrompt: string, input: string | ChatMessage[]): { system: any[]; messages: any[] } {
  const systemTexts: string[] = [systemPrompt];
  const messages: any[] = [];
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else {
    for (const m of input) {
      if (m.role === 'system') systemTexts.push(m.content);
      else messages.push({ role: m.role, content: m.content });
    }
  }
  // First block MUST be the Claude Code identity for OAuth requests to be accepted.
  const system = [{ type: 'text', text: CLAUDE_CODE_IDENTITY }, ...systemTexts.map((text) => ({ type: 'text', text }))];
  return { system, messages };
}

type AnthropicTurn = {
  text: string;
  reasoning: string;
  toolUses: { id: string; name: string; input: string }[];
  usage: { input: number; output: number };
  stopReason?: string;
};

/** POST one streaming /messages request and fold the SSE events into a turn. */
async function streamAnthropicTurn(
  accessToken: string,
  beta: string,
  model: string,
  system: any[],
  messages: any[],
  tools: ReturnType<typeof anthropicToolSpecs>,
  onEvent: ((e: AgentEvent) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<AnthropicTurn> {
  const res = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': beta,
    },
    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system, messages, tools: tools.length ? tools : undefined, stream: true }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    const err: any = new Error(`Claude (OAuth) ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    err.status = res.status;
    throw err;
  }

  const turn: AnthropicTurn = { text: '', reasoning: '', toolUses: [], usage: { input: 0, output: 0 } };
  // Track content blocks by index; tool_use blocks accumulate partial JSON.
  const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      switch (ev.type) {
        case 'message_start':
          turn.usage.input += ev.message?.usage?.input_tokens ?? 0;
          break;
        case 'content_block_start':
          blocks.set(ev.index, { type: ev.content_block?.type, id: ev.content_block?.id, name: ev.content_block?.name, json: '' });
          break;
        case 'content_block_delta': {
          const d = ev.delta ?? {};
          if (d.type === 'text_delta' && d.text) {
            turn.text += d.text;
            onEvent?.({ type: 'text', delta: d.text });
          } else if (d.type === 'thinking_delta' && d.thinking) {
            turn.reasoning += d.thinking;
            onEvent?.({ type: 'reasoning', delta: d.thinking });
          } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            const b = blocks.get(ev.index);
            if (b) b.json += d.partial_json;
          }
          break;
        }
        case 'message_delta':
          turn.usage.output += ev.usage?.output_tokens ?? 0;
          if (ev.delta?.stop_reason) turn.stopReason = ev.delta.stop_reason;
          break;
      }
    }
  }
  for (const b of blocks.values()) {
    if (b.type === 'tool_use' && b.name) turn.toolUses.push({ id: b.id || b.name, name: b.name, input: b.json || '{}' });
  }
  return turn;
}

export async function runClaudeOAuthAgent(
  config: AgentConfig,
  model: string,
  input: string | ChatMessage[],
  options?: AgentRunOptions,
): Promise<AgentRunResult> {
  const { accessToken, beta } = await readClaudeOAuth();
  const wireModel = claudeModelFromId(model);
  const tools = options?.noTools ? [] : anthropicToolSpecs();
  const toolByName = new Map<string, LocalTool>(localTools().map((t) => [t.function.name, t] as const));

  const systemPrompt = (options?.instructions ?? config.systemPrompt).replace('{cwd}', process.cwd());
  const { system, messages } = toAnthropic(systemPrompt, input);
  const usage = { inputTokens: 0, outputTokens: 0 };
  let finalText = '';

  for (let step = 0; step < config.maxSteps; step++) {
    if (options?.signal?.aborted) break;
    const turn = await streamAnthropicTurn(accessToken, beta, wireModel, system, messages, tools, options?.onEvent, options?.signal);
    usage.inputTokens += turn.usage.input;
    usage.outputTokens += turn.usage.output;

    if (turn.toolUses.length === 0) {
      finalText = turn.text;
      break;
    }

    // Record the assistant turn (text + tool_use blocks) then the tool results.
    const assistantContent: any[] = [];
    if (turn.text) assistantContent.push({ type: 'text', text: turn.text });
    for (const tu of turn.toolUses) {
      let args: Record<string, unknown> = {};
      try {
        args = tu.input ? JSON.parse(tu.input) : {};
      } catch {
        /* malformed → empty; tool validation reports it */
      }
      assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: args });
    }
    messages.push({ role: 'assistant', content: assistantContent });

    const results: any[] = [];
    for (const tu of turn.toolUses) {
      let args: Record<string, unknown> = {};
      try {
        args = tu.input ? JSON.parse(tu.input) : {};
      } catch {
        /* ignore */
      }
      options?.onEvent?.({ type: 'tool_call', name: tu.name, callId: tu.id, args });
      const t = toolByName.get(tu.name);
      let outStr: string;
      if (!t) {
        outStr = JSON.stringify({ error: `Unknown tool: ${tu.name}` });
      } else {
        try {
          const result = await t.function.execute(args);
          outStr = typeof result === 'string' ? result : JSON.stringify(result);
        } catch (err: any) {
          outStr = JSON.stringify({ error: err?.message ?? String(err) });
        }
      }
      options?.onEvent?.({ type: 'tool_result', name: tu.name, callId: tu.id, output: outStr.length > 300 ? outStr.slice(0, 300) + '…' : outStr });
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: outStr });
    }
    messages.push({ role: 'user', content: results });
  }

  return { text: finalText, usage, output: [] };
}
