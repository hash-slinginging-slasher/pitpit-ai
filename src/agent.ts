import { OpenRouter } from '@openrouter/agent';
import type { Item } from '@openrouter/agent';
import { stepCountIs, maxCost } from '@openrouter/agent/stop-conditions';
import type { AgentConfig } from './config.js';
import { isLocalModel } from './config.js';
import { runLocalAgent } from './local-agent.js';
import { tools } from './tools/index.js';

export type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string };

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; callId: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; callId: string; output: string }
  | { type: 'reasoning'; delta: string };

/** Shared run options. `noTools`/`instructions` support one-off calls like summarization. */
export interface RunOptions {
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /** Send no tools this call (e.g. plain summarization) — the model just returns text. */
  noTools?: boolean;
  /** Override the system prompt for this call without mutating shared config. */
  instructions?: string;
}

export async function runAgent(
  config: AgentConfig,
  model: string,
  input: string | ChatMessage[],
  options?: RunOptions,
) {
  // Local llama.cpp models don't speak the OpenRouter Responses API — run them
  // through the chat/completions tool loop instead (no API key required).
  if (isLocalModel(model)) {
    return runLocalAgent(config, model, input, options);
  }

  const client = new OpenRouter({ apiKey: config.apiKey });

  const result = client.callModel({
    model,
    instructions: (options?.instructions ?? config.systemPrompt).replace('{cwd}', process.cwd()),
    input: input as string | Item[],
    tools: options?.noTools ? undefined : tools,
    stopWhen: [stepCountIs(config.maxSteps), maxCost(config.maxCost)],
  });

  if (options?.onEvent) {
    // Track streamed text length per message item id. A multi-step agent emits
    // multiple message items over one run (one per assistant turn between tool
    // calls); each grows from 0 to its final length. A single global cursor
    // would slice mid-string on the second message.
    const textByItem = new Map<string, number>();
    const callNames = new Map<string, string>();

    for await (const item of result.getItemsStream()) {
      if (options?.signal?.aborted) break;
      if (item.type === 'message') {
        const text =
          item.content
            ?.filter((c): c is { type: 'output_text'; text: string } => 'text' in c)
            .map((c) => c.text)
            .join('') ?? '';
        const prev = textByItem.get(item.id) ?? 0;
        if (text.length > prev) {
          options.onEvent({ type: 'text', delta: text.slice(prev) });
          textByItem.set(item.id, text.length);
        }
      } else if (item.type === 'function_call') {
        callNames.set(item.callId, item.name);
        if (item.status === 'completed') {
          const args = (() => {
            try {
              return item.arguments ? JSON.parse(item.arguments) : {};
            } catch {
              return {};
            }
          })();
          options.onEvent({ type: 'tool_call', name: item.name, callId: item.callId, args });
        }
      } else if (item.type === 'function_call_output') {
        const out = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
        options.onEvent({
          type: 'tool_result',
          name: callNames.get(item.callId) ?? 'unknown',
          callId: item.callId,
          output: out.length > 300 ? out.slice(0, 300) + '…' : out,
        });
      } else if (item.type === 'reasoning') {
        const text = item.summary?.map((s: { text: string }) => s.text).join('') ?? '';
        if (text) options.onEvent({ type: 'reasoning', delta: text });
      }
    }
  }

  const response = await result.getResponse();
  // Some models leave response.outputText empty even though they streamed text via
  // message items — reconstruct the assistant text from the output in that case.
  let text = response.outputText ?? '';
  if (!text && Array.isArray(response.output)) {
    text = response.output
      .filter((it: any) => it.type === 'message')
      .map((it: any) =>
        (it.content ?? [])
          .filter((c: any) => c && typeof c.text === 'string')
          .map((c: any) => c.text)
          .join(''),
      )
      .join('\n')
      .trim();
  }
  return { text, usage: response.usage, output: response.output };
}

export async function runAgentWithRetry(
  config: AgentConfig,
  model: string,
  input: string | ChatMessage[],
  options?: RunOptions & { maxRetries?: number },
) {
  for (let attempt = 0, max = options?.maxRetries ?? 3; attempt <= max; attempt++) {
    try {
      return await runAgent(config, model, input, options);
    } catch (err: any) {
      const s = err?.status ?? err?.statusCode;
      if (!(s === 429 || (s >= 500 && s < 600)) || attempt === max) throw err;
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 30000)));
    }
  }
  throw new Error('Unreachable');
}

/**
 * Run through an agent's failover chain: try the primary model; on a hard failure
 * (after per-model retries) move to the next model, and so on. Throws only if every
 * model in the chain fails. `onFailover` fires when moving to a backup model.
 */
export async function runAgentChain(
  config: AgentConfig,
  models: string[],
  input: string | ChatMessage[],
  options?: RunOptions & {
    onFailover?: (info: { from: string; to: string; index: number; error: string }) => void;
  },
) {
  if (models.length === 0) {
    throw new Error('No models configured for this agent. Add one in the web UI.');
  }
  let lastErr: any;
  for (let i = 0; i < models.length; i++) {
    try {
      const result = await runAgentWithRetry(config, models[i], input, options);
      return { ...result, model: models[i], failedOver: i > 0 };
    } catch (err: any) {
      lastErr = err;
      if (i < models.length - 1) {
        options?.onFailover?.({
          from: models[i],
          to: models[i + 1],
          index: i + 1,
          error: err?.message ?? String(err),
        });
      }
    }
  }
  throw lastErr;
}
