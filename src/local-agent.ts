import { z } from 'zod';
import type { AgentConfig } from './config.js';
import { LOCAL_MODEL_PREFIX, localBaseUrl } from './config.js';
import { tools } from './tools/index.js';
import type { AgentEvent, ChatMessage } from './agent.js';

/**
 * Runs the agent against a local llama.cpp `llama-server` instead of OpenRouter.
 *
 * llama.cpp exposes an OpenAI-compatible `/v1/chat/completions` endpoint but does
 * NOT implement OpenRouter's `/responses` API (which the @openrouter/agent SDK
 * uses). So this module re-implements the tool-calling loop directly against
 * chat/completions, while emitting the same AgentEvent stream and return shape as
 * runAgent() — so the CLI renderer and web history work unchanged.
 *
 * Reasoning models (like Ornith) emit a `<think>…</think>` block. With
 * `--jinja --reasoning-format auto`, llama.cpp splits that into a separate
 * `delta.reasoning_content` field; we surface it as `reasoning` events. As a
 * fallback we also parse inline `<think>` tags out of the content stream.
 */

/** Only client tools can run locally — server tools (OpenRouter web_search) have no execute. */
export type LocalTool = { function: { name: string; description?: string; inputSchema: unknown; execute: (args: any) => unknown } };

export function localTools(): LocalTool[] {
  return (tools as unknown as any[]).filter(
    (t) => t && t.function && typeof t.function.execute === 'function',
  );
}

/** Build the OpenAI `tools` array (function specs) from the client tools. */
function toolSpecs() {
  return localTools().map((t) => ({
    type: 'function' as const,
    function: {
      name: t.function.name,
      description: t.function.description ?? '',
      parameters: z.toJSONSchema(t.function.inputSchema as any, { target: 'draft-7' }),
    },
  }));
}

/** Map the agent's input (string or chat history) into OpenAI chat messages. */
function toChatMessages(systemPrompt: string, input: string | ChatMessage[]): any[] {
  const msgs: any[] = [{ role: 'system', content: systemPrompt }];
  if (typeof input === 'string') {
    msgs.push({ role: 'user', content: input });
  } else {
    for (const m of input) msgs.push({ role: m.role, content: m.content });
  }
  return msgs;
}

type StreamedTurn = {
  content: string;
  reasoning: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  finishReason?: string;
};

/**
 * Splits a raw content stream into visible text vs. reasoning, tracking whether we
 * are currently inside a `<think>…</think>` block (fallback for servers that don't
 * separate reasoning_content). Returns the deltas to emit for this chunk.
 */
function makeThinkSplitter() {
  let inThink = false;
  let carry = ''; // holds a partial tag like "<thi" spanning a chunk boundary
  return (chunk: string): { text: string; reasoning: string } => {
    let buf = carry + chunk;
    carry = '';
    let text = '';
    let reasoning = '';
    while (buf) {
      const tag = inThink ? '</think>' : '<think>';
      const idx = buf.indexOf(tag);
      if (idx === -1) {
        // Hold back a possible partial tag at the end so we don't split it.
        const keep = Math.min(tag.length - 1, buf.length);
        const safe = buf.slice(0, buf.length - keep);
        const tail = buf.slice(buf.length - keep);
        if (tag.startsWith(tail) && tail.length > 0) {
          carry = tail;
          (inThink ? (reasoning += safe) : (text += safe));
        } else {
          (inThink ? (reasoning += buf) : (text += buf));
        }
        break;
      }
      (inThink ? (reasoning += buf.slice(0, idx)) : (text += buf.slice(0, idx)));
      buf = buf.slice(idx + tag.length);
      inThink = !inThink;
    }
    return { text, reasoning };
  };
}

/** POST one streaming chat/completions request and fold the SSE deltas into a turn. */
async function streamTurn(
  baseUrl: string,
  model: string,
  messages: any[],
  specs: ReturnType<typeof toolSpecs>,
  onEvent: ((e: AgentEvent) => void) | undefined,
  signal: AbortSignal | undefined,
  auth?: { apiKey?: string; extraHeaders?: Record<string, string> },
): Promise<StreamedTurn> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(auth?.extraHeaders ?? {}) };
  if (auth?.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model,
      messages,
      tools: specs.length ? specs : undefined,
      tool_choice: specs.length ? 'auto' : undefined,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    const err: any = new Error(`Local server ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    err.status = res.status;
    throw err;
  }

  const turn: StreamedTurn = { content: '', reasoning: '', toolCalls: [] };
  const splitThink = makeThinkSplitter();
  const decoder = new TextDecoder();
  let buffer = '';

  const emitContent = (raw: string) => {
    const { text, reasoning } = splitThink(raw);
    if (reasoning) {
      turn.reasoning += reasoning;
      onEvent?.({ type: 'reasoning', delta: reasoning });
    }
    if (text) {
      turn.content += text;
      onEvent?.({ type: 'text', delta: text });
    }
  };

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
      if (data === '[DONE]') continue;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.usage) turn.usage = json.usage;
      const choice = json.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        turn.reasoning += delta.reasoning_content;
        onEvent?.({ type: 'reasoning', delta: delta.reasoning_content });
      }
      if (typeof delta.content === 'string' && delta.content) emitContent(delta.content);
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          const slot = (turn.toolCalls[i] ??= { id: '', name: '', arguments: '' });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.arguments += tc.function.arguments;
        }
      }
      if (choice.finish_reason) turn.finishReason = choice.finish_reason;
    }
  }
  turn.toolCalls = turn.toolCalls.filter((t) => t && t.name);
  return turn;
}

export interface AgentRunOptions {
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  noTools?: boolean;
  instructions?: string;
}

export type AgentRunResult = { text: string; usage: { inputTokens: number; outputTokens: number }; output: unknown[] };

/** How to reach one OpenAI-compatible backend (local llama.cpp, NVIDIA build, GitHub Models, …). */
export interface OpenAICompatTarget {
  /** Base URL ending at the `/v1` root (no trailing slash). */
  baseUrl: string;
  /** Wire model name the backend expects (prefix already stripped). */
  wireModel: string;
  /** Bearer key, if the backend needs one (local llama.cpp needs none). */
  apiKey?: string;
  /** Extra request headers (e.g. GitHub's `X-GitHub-Api-Version`). */
  extraHeaders?: Record<string, string>;
}

/**
 * Runs the agent's tool-calling loop against any OpenAI-compatible
 * `/chat/completions` backend. Shared by local llama.cpp, NVIDIA build, and
 * GitHub Models — they differ only in base URL + auth. Emits the same
 * AgentEvent stream and return shape as runAgent() so the CLI + web history
 * work unchanged.
 */
export async function runOpenAICompatibleAgent(
  target: OpenAICompatTarget,
  config: AgentConfig,
  input: string | ChatMessage[],
  options?: AgentRunOptions,
): Promise<AgentRunResult> {
  const { baseUrl, wireModel, apiKey, extraHeaders } = target;
  const auth = { apiKey, extraHeaders };
  const specs = options?.noTools ? [] : toolSpecs();
  const toolByName = options?.noTools
    ? new Map<string, LocalTool>()
    : new Map(localTools().map((t) => [t.function.name, t] as const));

  const systemPrompt = (options?.instructions ?? config.systemPrompt).replace('{cwd}', process.cwd());
  const messages = toChatMessages(systemPrompt, input);
  const usage = { inputTokens: 0, outputTokens: 0 };
  const callNames = new Map<string, string>();
  let finalText = '';

  for (let step = 0; step < config.maxSteps; step++) {
    if (options?.signal?.aborted) break;
    const turn = await streamTurn(baseUrl, wireModel, messages, specs, options?.onEvent, options?.signal, auth);
    usage.inputTokens += turn.usage?.prompt_tokens ?? 0;
    usage.outputTokens += turn.usage?.completion_tokens ?? 0;

    if (turn.toolCalls.length === 0) {
      finalText = turn.content;
      break;
    }

    // Record the assistant turn (with its tool-call requests) before the results.
    messages.push({
      role: 'assistant',
      content: turn.content || null,
      tool_calls: turn.toolCalls.map((t) => ({
        id: t.id || t.name,
        type: 'function',
        function: { name: t.name, arguments: t.arguments || '{}' },
      })),
    });

    for (const call of turn.toolCalls) {
      const callId = call.id || call.name;
      callNames.set(callId, call.name);
      let args: Record<string, unknown> = {};
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        /* malformed args → empty; tool validation will report it */
      }
      options?.onEvent?.({ type: 'tool_call', name: call.name, callId, args });

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
      options?.onEvent?.({
        type: 'tool_result',
        name: call.name,
        callId,
        output: outStr.length > 300 ? outStr.slice(0, 300) + '…' : outStr,
      });
      messages.push({ role: 'tool', tool_call_id: callId, content: outStr });
    }
  }

  return { text: finalText, usage, output: [] };
}

/**
 * Runs the agent against a local llama.cpp `llama-server`. Thin wrapper over
 * runOpenAICompatibleAgent: the local server needs no API key and serves whatever
 * model is loaded, so we just strip the "local/" prefix for a readable wire name.
 */
export async function runLocalAgent(
  config: AgentConfig,
  model: string,
  input: string | ChatMessage[],
  options?: AgentRunOptions,
): Promise<AgentRunResult> {
  const wireModel = model.slice(LOCAL_MODEL_PREFIX.length) || 'local';
  return runOpenAICompatibleAgent({ baseUrl: localBaseUrl(), wireModel }, config, input, options);
}
