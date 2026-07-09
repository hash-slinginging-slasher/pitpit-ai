import { z } from 'zod';
import type { AgentConfig } from '../config.js';
import { localTools, type LocalTool, type AgentRunOptions, type AgentRunResult } from '../local-agent.js';
import type { AgentEvent, ChatMessage } from '../agent.js';
import { readCodexOAuth } from './credentials.js';

/**
 * EXPERIMENTAL `codex-oauth` transport for cli/codex on a ChatGPT subscription.
 * Drives our tool loop against the ChatGPT backend's Responses API using the token
 * `codex login` stored in ~/.codex/auth.json — the same backend the Codex CLI uses.
 *
 * The endpoint, headers, and request shape are undocumented (reverse-engineered from
 * codex-rs) and can change without notice. This has NOT been validated on a machine
 * with a real Codex subscription; expect to iterate on errors. When Codex is logged
 * in with an API key instead, cli-agent uses the standard OpenAI path (not this).
 */

const CHATGPT_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
// ChatGPT-account Codex rejects some API model ids (e.g. gpt-5-codex). gpt-5 is the
// broadly-available one; override per model with cli/codex/<model> if your plan differs.
const DEFAULT_CODEX_MODEL = 'gpt-5';

/** Wire model id from `cli/codex[/<model>]`. */
export function codexModelFromId(model: string): string {
  const rest = model.replace(/^cli\/codex\/?/, '');
  return rest || DEFAULT_CODEX_MODEL;
}

/** Responses API tool specs (flat function shape) from our client tools. */
export function responsesToolSpecs() {
  return localTools().map((t) => ({
    type: 'function' as const,
    name: t.function.name,
    description: t.function.description ?? '',
    parameters: z.toJSONSchema(t.function.inputSchema as any, { target: 'draft-7' }),
    strict: false,
  }));
}

/** Split system prompt + chat history into Responses `instructions` + `input` items. */
export function toResponsesInput(systemPrompt: string, input: string | ChatMessage[]): { instructions: string; items: any[] } {
  const systemParts: string[] = [systemPrompt];
  const items: any[] = [];
  const msg = (role: string, text: string) =>
    items.push({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
  if (typeof input === 'string') {
    msg('user', input);
  } else {
    for (const m of input) {
      if (m.role === 'system') systemParts.push(m.content);
      else msg(m.role, m.content);
    }
  }
  return { instructions: systemParts.join('\n\n'), items };
}

type CodexTurn = {
  text: string;
  reasoning: string;
  toolCalls: { callId: string; name: string; arguments: string }[];
  usage: { input: number; output: number };
};

/** POST one streaming Responses request to the ChatGPT backend and fold the SSE events. */
async function streamCodexTurn(
  auth: { accessToken: string; accountId: string },
  model: string,
  instructions: string,
  inputItems: any[],
  tools: ReturnType<typeof responsesToolSpecs>,
  onEvent: ((e: AgentEvent) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<CodexTurn> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${auth.accessToken}`,
    'OpenAI-Beta': 'responses=experimental',
    originator: 'codex_cli_rs',
  };
  if (auth.accountId) headers['chatgpt-account-id'] = auth.accountId;

  const res = await fetch(CHATGPT_RESPONSES_URL, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({
      model,
      instructions,
      input: inputItems,
      tools: tools.length ? tools : undefined,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      store: false,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    const hint = /model.*(not supported|does not exist|not found)/i.test(detail)
      ? ` — try another model via cli/codex/<model> (e.g. gpt-5, gpt-5-mini, codex-mini-latest, o4-mini).`
      : '';
    const err: any = new Error(`Codex (ChatGPT) ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 300)}` : ''}${hint}`);
    err.status = res.status;
    throw err;
  }

  const turn: CodexTurn = { text: '', reasoning: '', toolCalls: [], usage: { input: 0, output: 0 } };
  // Responses streams function calls as output items; args arrive as deltas keyed by
  // the item id. Track item_id -> tool call so we can accumulate arguments.
  const callsByItem = new Map<string, { callId: string; name: string; arguments: string }>();
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
        case 'response.output_text.delta':
          if (typeof ev.delta === 'string') {
            turn.text += ev.delta;
            onEvent?.({ type: 'text', delta: ev.delta });
          }
          break;
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          if (typeof ev.delta === 'string') {
            turn.reasoning += ev.delta;
            onEvent?.({ type: 'reasoning', delta: ev.delta });
          }
          break;
        case 'response.output_item.added':
          if (ev.item?.type === 'function_call') {
            callsByItem.set(ev.item.id, { callId: ev.item.call_id, name: ev.item.name, arguments: ev.item.arguments ?? '' });
          }
          break;
        case 'response.function_call_arguments.delta': {
          const c = callsByItem.get(ev.item_id);
          if (c && typeof ev.delta === 'string') c.arguments += ev.delta;
          break;
        }
        case 'response.output_item.done':
          if (ev.item?.type === 'function_call') {
            const c = callsByItem.get(ev.item.id);
            if (c) {
              if (ev.item.arguments) c.arguments = ev.item.arguments;
              if (ev.item.call_id) c.callId = ev.item.call_id;
            } else {
              callsByItem.set(ev.item.id, { callId: ev.item.call_id, name: ev.item.name, arguments: ev.item.arguments ?? '' });
            }
          }
          break;
        case 'response.completed': {
          const u = ev.response?.usage;
          if (u) {
            turn.usage.input = u.input_tokens ?? 0;
            turn.usage.output = u.output_tokens ?? 0;
          }
          break;
        }
      }
    }
  }
  turn.toolCalls = [...callsByItem.values()].filter((c) => c.name);
  return turn;
}

export async function runCodexOAuthAgent(
  config: AgentConfig,
  model: string,
  input: string | ChatMessage[],
  options?: AgentRunOptions,
): Promise<AgentRunResult> {
  const auth = await readCodexOAuth();
  const wireModel = codexModelFromId(model);
  const tools = options?.noTools ? [] : responsesToolSpecs();
  const toolByName = new Map<string, LocalTool>(localTools().map((t) => [t.function.name, t] as const));
  const systemPrompt = (options?.instructions ?? config.systemPrompt).replace('{cwd}', process.cwd());
  const { instructions, items } = toResponsesInput(systemPrompt, input);
  const usage = { inputTokens: 0, outputTokens: 0 };
  let finalText = '';

  for (let step = 0; step < config.maxSteps; step++) {
    if (options?.signal?.aborted) break;
    const turn = await streamCodexTurn(auth, wireModel, instructions, items, tools, options?.onEvent, options?.signal);
    usage.inputTokens += turn.usage.input;
    usage.outputTokens += turn.usage.output;

    if (turn.toolCalls.length === 0) {
      finalText = turn.text;
      break;
    }

    // Echo the model's function_call items, then append each tool result.
    for (const call of turn.toolCalls) {
      items.push({ type: 'function_call', call_id: call.callId, name: call.name, arguments: call.arguments || '{}' });
    }
    for (const call of turn.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        /* malformed → empty; tool validation reports it */
      }
      options?.onEvent?.({ type: 'tool_call', name: call.name, callId: call.callId, args });
      const t = toolByName.get(call.name);
      let outStr: string;
      if (!t) {
        outStr = JSON.stringify({ error: `Unknown tool: ${call.name}` });
      } else {
        try {
          const result = await t.function.execute(args);
          outStr = typeof result === 'string' ? result : JSON.stringify(result);
        } catch (err: any) {
          outStr = JSON.stringify({ error: err?.message ?? String(err) });
        }
      }
      options?.onEvent?.({ type: 'tool_result', name: call.name, callId: call.callId, output: outStr.length > 300 ? outStr.slice(0, 300) + '…' : outStr });
      items.push({ type: 'function_call_output', call_id: call.callId, output: outStr });
    }
  }

  return { text: finalText, usage, output: [] };
}
