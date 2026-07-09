import { spawn } from 'child_process';
import type { AgentConfig } from '../config.js';
import type { AgentRunOptions, AgentRunResult } from '../local-agent.js';
import type { ChatMessage } from '../agent.js';
import { resolveCliPath } from './credentials.js';

/**
 * `cli/opencode` router. OpenCode (opencode-ai) is an open-source terminal coding
 * agent with its own tools + provider auth. Like Jules it's a full agent, but it runs
 * LOCALLY and edits the current directory — so we delegate the turn to `opencode run`
 * and stream its output back. Our own tools/system prompt don't apply to this model;
 * OpenCode uses whatever provider/model you configured via `opencode auth login`.
 *
 * Override the model with cli/opencode/<provider/model> (e.g. cli/opencode/anthropic/claude-sonnet-4-5).
 */

function latestPrompt(input: string | ChatMessage[]): string {
  return typeof input === 'string' ? input : [...input].reverse().find((m) => m.role === 'user')?.content ?? '';
}

export async function runOpenCodeAgent(
  _config: AgentConfig,
  model: string,
  input: string | ChatMessage[],
  options?: AgentRunOptions,
): Promise<AgentRunResult> {
  const bin = resolveCliPath('opencode');
  if (!bin) {
    throw new Error('opencode is not installed. Install it (npm i -g opencode-ai) or use the Install button in the web UI.');
  }
  const prompt = latestPrompt(input);
  if (!prompt.trim()) throw new Error('cli/opencode: empty prompt.');

  const modelArg = model.replace(/^cli\/opencode\/?/, '');
  const args = ['run', ...(modelArg ? ['--model', modelArg] : []), prompt];

  options?.onEvent?.({ type: 'reasoning', delta: 'Delegating to opencode (edits files in this directory)…\n' });

  return new Promise<AgentRunResult>((resolvePromise, reject) => {
    // Run without shell so the prompt is a safe argv element (no injection). On
    // Windows the target is an npm `.cmd` shim, which cmd.exe must launch.
    const isWin = process.platform === 'win32';
    const cmd = isWin ? process.env.COMSPEC || 'cmd.exe' : bin;
    const fullArgs = isWin ? ['/d', '/s', '/c', bin, ...args] : args;
    const child = spawn(cmd, fullArgs, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      options?.onEvent?.({ type: 'text', delta: s });
    });
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    options?.signal?.addEventListener('abort', () => child.kill(), { once: true });
    child.on('close', (code) => {
      if (code === 0 && out.trim()) {
        resolvePromise({ text: out.trim(), usage: { inputTokens: 0, outputTokens: 0 }, output: [] });
      } else {
        const detail = err.trim() || out.trim() || 'no output';
        const hint = /login|auth|provider|api key|no model/i.test(detail)
          ? ' Run `opencode auth login` to set up a provider first.'
          : '';
        reject(new Error(`opencode run failed (exit ${code}): ${detail.slice(0, 300)}.${hint}`));
      }
    });
  });
}
