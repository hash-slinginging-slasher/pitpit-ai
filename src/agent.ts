import { OpenRouter } from '@openrouter/agent';
import type { Item } from '@openrouter/agent';
import { stepCountIs, maxCost } from '@openrouter/agent/stop-conditions';
import type { AgentConfig } from './config.js';
import {
  providerOf,
  stripPrefix,
  nvidiaBaseUrl,
  githubBaseUrl,
  groqBaseUrl,
  readNvidiaKey,
  readGithubToken,
  readGroqKey,
  orderedApiKeys,
  markKeyCooldown,
} from './config.js';
import { runLocalAgent, runOpenAICompatibleAgent } from './local-agent.js';
import { runCliAgent } from './providers/cli-agent.js';
import { tools } from './tools/index.js';

export type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string };

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; callId: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; callId: string; output: string }
  | { type: 'reasoning'; delta: string }
  // Which coder model is actively running (emitted when a leg starts / the coder changes),
  // so the user can see who is doing the work.
  | { type: 'coder'; model: string; index: number }
  // The conversational orchestrator handing a task to a coder subagent.
  | { type: 'delegate'; task: string }
  // Orchestrator events (only emitted when an orchestrator model is configured):
  | { type: 'plan'; steps: string[]; orchestrator: string; resumed?: boolean; source?: string }
  | { type: 'step'; phase: 'start' | 'done' | 'failed'; index: number; total: number; title: string; note?: string };

/** Shared run options. `noTools`/`instructions` support one-off calls like summarization. */
export interface RunOptions {
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /** Send no tools this call (e.g. plain summarization) — the model just returns text. */
  noTools?: boolean;
  /** Override the system prompt for this call without mutating shared config. */
  instructions?: string;
}

/** True if an error is (or an aborted signal implies) a user cancellation, not a real failure. */
export function isAbortError(err: any, signal?: AbortSignal): boolean {
  return !!signal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}

/**
 * True if a failure message means the USER must do something to proceed (add credits, a key,
 * a token, wait out a quota, sign in). Used to surface such messages in red.
 */
export function needsUserAction(message: string): boolean {
  return /rate.?limit|add .*credit|api key|no .*key|quota|insufficient|unauthoriz|payment|sign in|log ?in|402|401|429/i.test(
    message || '',
  );
}

/**
 * True if an OpenRouter failure is the KEY's/account's fault (rate-limited for the day, out of
 * credit, bad key) so a DIFFERENT key might succeed. False for upstream/model failures — a
 * "Provider returned error" (which OpenRouter passes through as a 429), a 403 Forbidden, a
 * provider 5xx, etc. hit the same broken model on every key, so rotating just wastes a good
 * key; those must fail over to the next MODEL instead.
 */
function isKeyExhausted(err: any): boolean {
  const s = err?.status ?? err?.statusCode;
  const msg = String(err?.message || '');
  // Model/provider-level failures — never a key problem, even when dressed up as a 429.
  if (
    /provider returned error|stream ended|no instances|provider error|overloaded|temporarily unavailable|internal server error|bad gateway|service unavailable|timed? ?out|forbidden|not found/i.test(
      msg,
    )
  ) {
    return false;
  }
  // Invalid key / out of credit → another key genuinely may work.
  if (s === 401 || s === 402) return true;
  // Account/key rate or daily limit (per-key) — the whole reason for multiple keys. A BARE 429
  // with none of these signals is treated as a provider issue (fail over the model, don't bench).
  return /free.?models.?per.?day|rate.?limit|requests? per day|too many requests|quota|insufficient|add \d+ credits?|payment required|unauthoriz|invalid api key/i.test(
    msg,
  );
}

/**
 * True if a model failure is PERMANENT — the model id is inaccessible or invalid (403 Forbidden,
 * 404 Not Found, 413 payload too large for that endpoint), so it will fail every time it's tried.
 * Such a model should be pruned from the chain, not merely demoted (which just retries it later).
 */
export function isPermanentModelError(err: any): boolean {
  const s = err?.status ?? err?.statusCode;
  if (s === 403 || s === 404 || s === 413) return true;
  return /\b(403|404|413)\b|forbidden|not found|payload too large|request entity too large|no endpoints?( found)?|invalid model|unknown model|model .*(not found|does not exist|is not available|unavailable)/i.test(
    String(err?.message || ''),
  );
}

/** Next 00:00 UTC after `now` — when OpenRouter's free-models-per-day quota resets. */
function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

/**
 * How long to bench an exhausted key. A daily/credit limit ("free-models-per-day", out of
 * credit, 402) is done until the next UTC midnight; a plain per-minute rate limit recovers
 * quickly, so bench it only briefly.
 */
function cooldownUntilFor(err: any): number {
  const now = Date.now();
  const msg = String(err?.message || '');
  const s = err?.status ?? err?.statusCode;
  if (s === 402 || /per.?day|daily|free-models-per-day|add .*credit|insufficient|payment required/i.test(msg)) {
    return nextUtcMidnight(now);
  }
  return now + 5 * 60_000; // transient rate limit / auth blip
}

export async function runAgent(
  config: AgentConfig,
  model: string,
  input: string | ChatMessage[],
  options?: RunOptions,
) {
  // Route by the model id's provider prefix. Only bare/openrouter ids use the
  // OpenRouter Responses SDK below; everything else has its own transport.
  const provider = providerOf(model);
  if (provider === 'local') {
    return runLocalAgent(config, model, input, options);
  }
  if (provider === 'nvidia') {
    return runOpenAICompatibleAgent(
      { baseUrl: nvidiaBaseUrl(), wireModel: stripPrefix(model), apiKey: readNvidiaKey() },
      config,
      input,
      options,
    );
  }
  if (provider === 'github') {
    return runOpenAICompatibleAgent(
      { baseUrl: githubBaseUrl(), wireModel: stripPrefix(model), apiKey: readGithubToken() },
      config,
      input,
      options,
    );
  }
  if (provider === 'groq') {
    return runOpenAICompatibleAgent(
      { baseUrl: groqBaseUrl(), wireModel: stripPrefix(model), apiKey: readGroqKey() },
      config,
      input,
      options,
    );
  }
  if (provider === 'cli-claude' || provider === 'cli-codex' || provider === 'cli-gemini' || provider === 'cli-jules' || provider === 'cli-opencode') {
    return runCliAgent(provider, config, model, input, options);
  }

  // OpenRouter: try each configured key in order, rotating to the next when one is
  // rate-limited / out of credit (a key problem, not a model problem). Only rotate before
  // any text has streamed — once the model has emitted output, retrying would duplicate it.
  // orderedApiKeys() skips keys benched for the day, so an exhausted key stays skipped across
  // tasks (not just within one request) until its cooldown lapses.
  const keys = orderedApiKeys();
  const keyList = keys.length ? keys : [config.apiKey];
  let streamedAny = false;
  const rotOptions: RunOptions | undefined = options?.onEvent
    ? {
        ...options,
        onEvent: (e: AgentEvent) => {
          if (e.type === 'text' || e.type === 'reasoning') streamedAny = true;
          options.onEvent!(e);
        },
      }
    : options;
  let lastErr: any;
  for (let ki = 0; ki < keyList.length; ki++) {
    streamedAny = false;
    try {
      return await runOpenRouterModel(keyList[ki], config, model, input, rotOptions);
    } catch (err: any) {
      lastErr = err;
      if (isAbortError(err, options?.signal)) throw err;
      const exhausted = !streamedAny && isKeyExhausted(err);
      // Bench this key so later tasks skip it (a daily limit lasts until UTC midnight).
      if (exhausted) markKeyCooldown(keyList[ki], cooldownUntilFor(err));
      if (!(exhausted && ki < keyList.length - 1)) throw err;
      console.warn(
        `[openrouter] key ${ki + 1}/${keyList.length} exhausted (${err?.status ?? err?.statusCode ?? ''} ${String(err?.message ?? '').slice(0, 80)}); benched, trying next key`,
      );
    }
  }
  throw lastErr;
}

/** Run one OpenRouter model with a specific API key. Extracted so runAgent can rotate keys. */
async function runOpenRouterModel(
  apiKey: string,
  config: AgentConfig,
  model: string,
  input: string | ChatMessage[],
  options?: RunOptions,
) {
  const client = new OpenRouter({ apiKey });

  const result = client.callModel({
    model,
    instructions: (options?.instructions ?? config.systemPrompt).replace('{cwd}', process.cwd()),
    input: input as string | Item[],
    tools: options?.noTools ? undefined : tools,
    stopWhen: [stepCountIs(config.maxSteps), maxCost(config.maxCost)],
  });

  let toolSteps = 0; // count tool calls to tell "finished" from "hit the step cap"
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
          toolSteps++;
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

  // If the user hit Esc mid-stream, stop here — don't wait on getResponse() and don't
  // let this surface as a model failure (the chain must not fail over on a cancel).
  if (options?.signal?.aborted) {
    void result.getResponse().catch(() => {}); // swallow the abandoned stream's rejection
    const e: any = new Error('Aborted by user');
    e.name = 'AbortError';
    throw e;
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
  // "max_steps" if the tool loop reached the per-leg cap (task likely unfinished);
  // otherwise the model stopped on its own → "completed". Count from the stream, or
  // fall back to the returned output items when nothing streamed.
  const outputSteps = Array.isArray(response.output)
    ? (response.output as any[]).filter((it) => it?.type === 'function_call').length
    : 0;
  const stopReason: 'completed' | 'max_steps' =
    Math.max(toolSteps, outputSteps) >= config.maxSteps ? 'max_steps' : 'completed';
  return { text, usage: response.usage, output: response.output, stopReason };
}

export async function runAgentWithRetry(
  config: AgentConfig,
  model: string,
  input: string | ChatMessage[],
  options?: RunOptions & { maxRetries?: number },
) {
  // Interactive CLI: retry a transient error (429 / 5xx) only briefly, then let the
  // failover chain move to the next model. Aggressive per-model backoff (e.g. 1→2→4s)
  // makes every turn on a rate-limited free model feel like a hang; the chain is the
  // real resilience, so fail over fast instead. Override maxRetries for batch callers.
  for (let attempt = 0, max = options?.maxRetries ?? 1; attempt <= max; attempt++) {
    try {
      return await runAgent(config, model, input, options);
    } catch (err: any) {
      const s = err?.status ?? err?.statusCode;
      if (!(s === 429 || (s >= 500 && s < 600)) || attempt === max) throw err;
      await new Promise((r) => setTimeout(r, Math.min(400 * 2 ** attempt, 1500)));
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
    onFailover?: (info: { from: string; to: string; index: number; error: string; permanent?: boolean }) => void;
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
      // Esc / cancel: stop the whole chain immediately — do not fall through to a backup model.
      if (isAbortError(err, options?.signal)) throw err;
      if (i < models.length - 1) {
        options?.onFailover?.({
          from: models[i],
          to: models[i + 1],
          index: i + 1,
          error: err?.message ?? String(err),
          permanent: isPermanentModelError(err),
        });
      }
    }
  }
  throw lastErr;
}

// Nudges that keep a long task moving across step-cap boundaries and coder handoffs,
// instead of restarting from the original prompt (which loses all prior progress).
const CONTINUE_PROMPT =
  'You paused after a batch of steps but the task is NOT finished. Continue from where you ' +
  'left off — the files on disk already reflect your progress so far. Do NOT restart from ' +
  'scratch; inspect the current state if needed, then keep working until the task is fully done.';
const HANDOFF_PROMPT =
  'The previous coder was interrupted before finishing this task. The files on disk reflect its ' +
  'PARTIAL progress. Do NOT restart from scratch — review the current state of the relevant files, ' +
  'then complete the remaining work until the task is fully done.';

export interface ResilientOptions extends RunOptions {
  /** Total continuation legs across the whole run (each leg = up to maxSteps tool calls). */
  maxRounds?: number;
  /** How many times to continue the SAME model on a step-cap before handing to the next. */
  maxContinuesPerModel?: number;
  onFailover?: (info: { from: string; to: string; index: number; error: string; permanent?: boolean }) => void;
  onContinue?: (info: { model: string; leg: number; reason: 'step-cap' | 'handoff' }) => void;
}

/**
 * Resilient task runner: keeps a task moving to completion across many steps and across
 * the coder chain. When a coder finishes, returns. When it hits the per-leg step cap but
 * the task isn't done, it CONTINUES (same coder, then hands off after a few tries). When a
 * coder errors, it hands off to the next coder — always preserving the running conversation
 * so the next coder continues from the current state instead of restarting. The local model
 * at the end of the chain, which never rate-limits, is the reliable anchor that finishes.
 */
export async function runResilientChain(
  config: AgentConfig,
  models: string[],
  input: string | ChatMessage[],
  options?: ResilientOptions,
) {
  if (models.length === 0) {
    throw new Error('No models configured for this agent. Add one in the web UI.');
  }
  const messages: ChatMessage[] = typeof input === 'string' ? [{ role: 'user', content: input }] : [...input];
  const maxRounds = options?.maxRounds ?? 12;
  const maxContinues = options?.maxContinuesPerModel ?? 4;

  let modelIdx = 0;
  let legs = 0;
  let continuesOnThisModel = 0;
  let announcedModel = '';
  let last: (Awaited<ReturnType<typeof runAgentWithRetry>> & { model: string }) | null = null;
  let lastErr: any;

  while (modelIdx < models.length && legs < maxRounds) {
    if (options?.signal?.aborted) {
      const e: any = new Error('Aborted by user');
      e.name = 'AbortError';
      throw e;
    }
    const model = models[modelIdx];
    // Announce who's about to run (once per coder change) so the user sees which model works.
    if (model !== announcedModel) {
      options?.onEvent?.({ type: 'coder', model, index: modelIdx });
      announcedModel = model;
    }
    try {
      const res = await runAgentWithRetry(config, model, messages, options);
      legs++;
      last = { ...res, model };
      if (res.text && res.text.trim()) messages.push({ role: 'assistant', content: res.text });

      if (res.stopReason !== 'max_steps') {
        return { ...res, model, failedOver: modelIdx > 0 }; // coder finished on its own
      }

      // Hit the per-leg step cap with work remaining. Keep the same coder going for a few
      // legs, then hand off to a fresh coder so we don't burn the whole budget on one.
      continuesOnThisModel++;
      if (continuesOnThisModel >= maxContinues && modelIdx + 1 < models.length) {
        options?.onContinue?.({ model, leg: legs, reason: 'handoff' });
        options?.onFailover?.({ from: model, to: models[modelIdx + 1], index: modelIdx + 1, error: 'step cap reached repeatedly' });
        messages.push({ role: 'user', content: HANDOFF_PROMPT });
        modelIdx++;
        continuesOnThisModel = 0;
      } else {
        options?.onContinue?.({ model, leg: legs, reason: 'step-cap' });
        messages.push({ role: 'user', content: CONTINUE_PROMPT });
      }
    } catch (err: any) {
      lastErr = err;
      if (isAbortError(err, options?.signal)) throw err;
      const nextIdx = modelIdx + 1;
      if (nextIdx < models.length) {
        options?.onFailover?.({ from: model, to: models[nextIdx], index: nextIdx, error: err?.message ?? String(err), permanent: isPermanentModelError(err) });
        messages.push({ role: 'user', content: HANDOFF_PROMPT });
      }
      modelIdx = nextIdx;
      continuesOnThisModel = 0;
    }
  }

  if (last) return { ...last, failedOver: modelIdx > 0 };
  throw lastErr ?? new Error('All coders failed');
}
