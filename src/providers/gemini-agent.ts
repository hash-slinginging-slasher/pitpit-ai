import { z } from 'zod';
import type { AgentConfig } from '../config.js';
import { readGeminiApiKey } from '../config.js';
import { localTools, type LocalTool, type AgentRunOptions, type AgentRunResult } from '../local-agent.js';
import type { AgentEvent, ChatMessage } from '../agent.js';
import { readGeminiOAuth, resolveCodeAssistProject, CODE_ASSIST_BASE } from './credentials.js';

/**
 * `gemini-generatecontent` transport for the cli/gemini router. Drives our tool loop
 * against Google's Gemini `generateContent` API, over either of two backends:
 *
 *   • Generative Language API (public, needs a Gemini API key) — the reliable,
 *     documented path. Used when readGeminiApiKey() returns a key.
 *   • Code Assist (cloudcode-pa) — the backend the Gemini CLI's personal/free tier
 *     uses, authorized by the CLI's OAuth token. Used otherwise. This path wraps the
 *     request in { model, project, request } and unwraps { response } from the reply.
 *
 * The wire format (contents/tools/systemInstruction) is identical between the two;
 * only endpoint, auth, and the request/response envelope differ. The pure translation
 * helpers below (toGeminiRequest, sanitizeGeminiSchema, readCandidate) are exported so
 * they can be unit-tested without any network calls.
 */

const GENLANG_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-pro';

/** Resolve the wire model id from a `cli/gemini[/<model>]` id. */
export function geminiModelFromId(model: string): string {
  const rest = model.replace(/^cli\/gemini\/?/, '');
  return rest || DEFAULT_GEMINI_MODEL;
}

/** JSON-schema keys Gemini's function-declaration `parameters` accepts. */
const GEMINI_SCHEMA_KEYS = new Set(['type', 'description', 'enum', 'items', 'properties', 'required', 'nullable', 'format']);

/**
 * Reduce a draft-7 JSON schema to the subset Gemini accepts: drop `$schema`,
 * `additionalProperties`, `$ref`, `default`, `const`, combinators, etc., and collapse a
 * nullable `type: [...]` union into a single type + `nullable: true`.
 */
export function sanitizeGeminiSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  const out: any = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue;
    if (k === 'type' && Array.isArray(v)) {
      const nonNull = v.filter((t) => t !== 'null');
      out.type = nonNull[0] ?? 'string';
      if (v.includes('null')) out.nullable = true;
    } else if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, sanitizeGeminiSchema(s)]));
    } else if (k === 'items') {
      out.items = sanitizeGeminiSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Gemini `tools` (functionDeclarations) from our client tools. */
export function geminiTools() {
  const decls = localTools().map((t) => ({
    name: t.function.name,
    description: t.function.description ?? '',
    parameters: sanitizeGeminiSchema(z.toJSONSchema(t.function.inputSchema as any, { target: 'draft-7' })),
  }));
  return decls.length ? [{ functionDeclarations: decls }] : [];
}

/** Build the Gemini request body pieces (systemInstruction + contents) from our input. */
export function toGeminiRequest(systemPrompt: string, input: string | ChatMessage[]): { systemInstruction: any; contents: any[] } {
  const systemTexts: string[] = [systemPrompt];
  const contents: any[] = [];
  const push = (role: string, text: string) => contents.push({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
  if (typeof input === 'string') {
    push('user', input);
  } else {
    for (const m of input) {
      if (m.role === 'system') systemTexts.push(m.content);
      else push(m.role, m.content);
    }
  }
  return { systemInstruction: { parts: systemTexts.map((text) => ({ text })) }, contents };
}

export type GeminiTurn = {
  text: string;
  functionCalls: { name: string; args: Record<string, unknown> }[];
  usage: { input: number; output: number };
};

/** Fold one streamed GenerateContentResponse chunk into an accumulating turn, emitting events. */
export function readCandidate(json: any, turn: GeminiTurn, onEvent?: (e: AgentEvent) => void): void {
  const gcr = json.response ?? json; // Code Assist wraps in { response: … }
  const parts = gcr.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    if (typeof p.text === 'string' && p.text) {
      turn.text += p.text;
      onEvent?.({ type: 'text', delta: p.text });
    } else if (p.functionCall?.name) {
      turn.functionCalls.push({ name: p.functionCall.name, args: p.functionCall.args ?? {} });
    }
  }
  const u = gcr.usageMetadata;
  if (u) {
    // Chunks report cumulative counts — keep the latest (max), don't sum.
    turn.usage.input = Math.max(turn.usage.input, u.promptTokenCount ?? 0);
    turn.usage.output = Math.max(turn.usage.output, u.candidatesTokenCount ?? 0);
  }
}

/** Where + how to reach a Gemini backend for one turn. */
type GeminiTarget =
  | { kind: 'apikey'; apiKey: string }
  | { kind: 'codeassist'; accessToken: string; project: string };

/** POST one streaming generateContent request and fold the SSE chunks into a turn. */
async function streamGeminiTurn(
  target: GeminiTarget,
  model: string,
  systemInstruction: any,
  contents: any[],
  tools: ReturnType<typeof geminiTools>,
  onEvent: ((e: AgentEvent) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<GeminiTurn> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let url: string;
  let body: any;
  const genReq = { contents, tools: tools.length ? tools : undefined, systemInstruction };
  if (target.kind === 'apikey') {
    headers['x-goog-api-key'] = target.apiKey;
    url = `${GENLANG_BASE}/models/${model}:streamGenerateContent?alt=sse`;
    body = genReq;
  } else {
    headers.Authorization = `Bearer ${target.accessToken}`;
    url = `${CODE_ASSIST_BASE}:streamGenerateContent?alt=sse`;
    body = { model, project: target.project || undefined, request: genReq };
  }

  const res = await fetch(url, { method: 'POST', headers, signal, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    const err: any = new Error(`Gemini ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    err.status = res.status;
    throw err;
  }

  const turn: GeminiTurn = { text: '', functionCalls: [], usage: { input: 0, output: 0 } };
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
      try {
        readCandidate(JSON.parse(data), turn, onEvent);
      } catch {
        /* skip malformed chunk */
      }
    }
  }
  return turn;
}

export async function runGeminiAgent(
  config: AgentConfig,
  model: string,
  input: string | ChatMessage[],
  options?: AgentRunOptions,
): Promise<AgentRunResult> {
  // Prefer the public API key when set; otherwise use the Gemini CLI's OAuth session.
  const apiKey = readGeminiApiKey();
  let target: GeminiTarget;
  if (apiKey) {
    target = { kind: 'apikey', apiKey };
  } else {
    const { accessToken } = readGeminiOAuth();
    const project = await resolveCodeAssistProject(accessToken);
    target = { kind: 'codeassist', accessToken, project };
  }

  const wireModel = geminiModelFromId(model);
  const tools = options?.noTools ? [] : geminiTools();
  const toolByName = new Map<string, LocalTool>(localTools().map((t) => [t.function.name, t] as const));
  const systemPrompt = (options?.instructions ?? config.systemPrompt).replace('{cwd}', process.cwd());
  const { systemInstruction, contents } = toGeminiRequest(systemPrompt, input);
  const usage = { inputTokens: 0, outputTokens: 0 };
  let finalText = '';

  for (let step = 0; step < config.maxSteps; step++) {
    if (options?.signal?.aborted) break;
    const turn = await streamGeminiTurn(target, wireModel, systemInstruction, contents, tools, options?.onEvent, options?.signal);
    usage.inputTokens += turn.usage.input;
    usage.outputTokens += turn.usage.output;

    if (turn.functionCalls.length === 0) {
      finalText = turn.text;
      break;
    }

    // Record the model's turn (text + functionCall parts), then the tool responses.
    const modelParts: any[] = [];
    if (turn.text) modelParts.push({ text: turn.text });
    for (const fc of turn.functionCalls) modelParts.push({ functionCall: { name: fc.name, args: fc.args } });
    contents.push({ role: 'model', parts: modelParts });

    const responseParts: any[] = [];
    for (const fc of turn.functionCalls) {
      options?.onEvent?.({ type: 'tool_call', name: fc.name, callId: fc.name, args: fc.args });
      const t = toolByName.get(fc.name);
      let outStr: string;
      if (!t) {
        outStr = JSON.stringify({ error: `Unknown tool: ${fc.name}` });
      } else {
        try {
          const result = await t.function.execute(fc.args);
          outStr = typeof result === 'string' ? result : JSON.stringify(result);
        } catch (err: any) {
          outStr = JSON.stringify({ error: err?.message ?? String(err) });
        }
      }
      options?.onEvent?.({ type: 'tool_result', name: fc.name, callId: fc.name, output: outStr.length > 300 ? outStr.slice(0, 300) + '…' : outStr });
      // Gemini expects the tool output as a structured functionResponse.
      responseParts.push({ functionResponse: { name: fc.name, response: { result: outStr } } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  return { text: finalText, usage, output: [] };
}
