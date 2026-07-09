import type { AgentConfig } from '../config.js';
import { readJulesApiKey, readJulesSource } from '../config.js';
import type { AgentRunOptions, AgentRunResult } from '../local-agent.js';
import type { ChatMessage } from '../agent.js';
import { remoteGithubSlug, currentBranch } from '../git.js';

/**
 * `jules` transport for the cli/jules router. Jules is NOT a completion endpoint —
 * it is an async autonomous agent that works on a connected GitHub repo in its own
 * VM and opens a pull request. So unlike the other routers it does NOT drive our
 * local tool loop or edit the current directory: we submit the task, stream Jules's
 * plan/progress/messages back as events, and return a summary plus the PR link.
 *
 * API: https://jules.googleapis.com/v1alpha, authed with an x-goog-api-key header
 * (a Jules API key from the jules.google web app, set via Settings or JULES_API_KEY).
 */

const JULES_BASE = 'https://jules.googleapis.com/v1alpha';
const POLL_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 min; override with JULES_TIMEOUT_MS

function timeoutMs(): number {
  const v = Number(process.env.JULES_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

async function julesFetch(apiKey: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${JULES_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err: any = new Error(`Jules ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? {} : res.json();
}

interface JulesSource {
  name: string;
  githubRepo?: { owner?: string; repo?: string; defaultBranch?: { displayName?: string } };
}

/** Resolve which Jules source (GitHub repo) + branch to run against. */
async function resolveSource(apiKey: string): Promise<{ source: string; branch?: string }> {
  const branch = (await currentBranch(process.cwd())) || undefined;
  const explicit = readJulesSource();
  if (explicit) return { source: explicit, branch };

  const slug = await remoteGithubSlug(process.cwd());
  if (!slug) {
    throw new Error(
      'cli/jules needs a GitHub repo. Run inside a repo whose `origin` is on GitHub and connected to ' +
        'Jules, or set a default source (JULES_SOURCE / Settings).',
    );
  }
  const body = (await julesFetch(apiKey, '/sources?pageSize=100')) as { sources?: JulesSource[] };
  const match = (body.sources ?? []).find(
    (s) =>
      s.githubRepo?.owner?.toLowerCase() === slug.owner.toLowerCase() &&
      s.githubRepo?.repo?.toLowerCase() === slug.repo.toLowerCase(),
  );
  if (!match) {
    throw new Error(
      `No Jules source is connected for ${slug.owner}/${slug.repo}. Connect the repo at https://jules.google, ` +
        `or set a default source (JULES_SOURCE / Settings).`,
    );
  }
  return { source: match.name, branch: branch || match.githubRepo?.defaultBranch?.displayName };
}

export type ActivityKind = 'agent' | 'progress' | 'plan' | 'completed' | 'failed' | 'other';

/**
 * Classify one activity object into a kind + human text, tolerating the API's
 * nested/flat field variants. Exported for unit testing (no network).
 */
export function classifyActivity(a: any): { kind: ActivityKind; text?: string; reason?: string; prUrl?: string } {
  const first = (...vals: any[]) => vals.find((v) => typeof v === 'string' && v);
  // Pull request link may live on a changeSet artifact.
  const prUrl = first(
    a.pullRequest?.url,
    a.prUrl,
    ...(a.artifacts ?? []).map((art: any) => art?.changeSet?.pullRequestUrl || art?.changeSet?.url),
  );
  if (a.sessionFailed || a.sessionFailure) return { kind: 'failed', reason: first(a.sessionFailed?.reason, a.sessionFailure?.reason) ?? 'unknown reason', prUrl };
  if (a.sessionCompleted || a.sessionCompletion) return { kind: 'completed', prUrl };
  const agent = first(a.agentMessaged?.agentMessage, a.agentMessaged?.message, a.agentMessage);
  if (agent) return { kind: 'agent', text: agent, prUrl };
  if (a.planGenerated || a.plan) {
    const steps = (a.planGenerated?.plan?.steps ?? a.plan?.steps ?? a.planGenerated?.steps ?? [])
      .map((s: any) => (typeof s === 'string' ? s : s.title || s.description))
      .filter(Boolean);
    return { kind: 'plan', text: steps.length ? `Plan:\n- ${steps.join('\n- ')}` : 'Plan generated.', prUrl };
  }
  if (a.progressUpdated || a.progressUpdate) {
    const p = a.progressUpdated ?? a.progressUpdate;
    const t = [p.title, p.description].filter(Boolean).join(' — ');
    return { kind: 'progress', text: t || 'Working…', prUrl };
  }
  return { kind: 'other', prUrl };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

export async function runJulesAgent(
  _config: AgentConfig,
  _model: string,
  input: string | ChatMessage[],
  options?: AgentRunOptions,
): Promise<AgentRunResult> {
  const apiKey = readJulesApiKey();
  if (!apiKey) {
    throw new Error('cli/jules needs a Jules API key. Create one at https://jules.google (Settings) and add it here (Settings or JULES_API_KEY).');
  }
  // Jules takes a single task prompt; use the latest user message.
  const prompt = typeof input === 'string' ? input : [...input].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (!prompt.trim()) throw new Error('cli/jules: empty prompt.');

  const { source, branch } = await resolveSource(apiKey);
  options?.onEvent?.({ type: 'reasoning', delta: `Submitting task to Jules (${source}${branch ? ` @ ${branch}` : ''})…\n` });

  const session = await julesFetch(apiKey, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      prompt,
      title: prompt.slice(0, 80),
      sourceContext: { source, githubRepoContext: branch ? { startingBranch: branch } : undefined },
      requirePlanApproval: false,
      automationMode: 'AUTO_CREATE_PR',
    }),
  });
  const sessionName: string = session.name || (session.id ? `sessions/${session.id}` : '');
  if (session.url) options?.onEvent?.({ type: 'reasoning', delta: `Jules session: ${session.url}\n` });

  // Poll activities until the session completes/fails or we time out.
  const seen = new Set<string>();
  const collected: string[] = [];
  let prUrl = '';
  const deadline = Date.now() + timeoutMs();
  let done = false;
  while (Date.now() < deadline && !done) {
    if (options?.signal?.aborted) break;
    const body = (await julesFetch(apiKey, `/${sessionName}/activities?pageSize=100`)) as { activities?: any[] };
    const acts = [...(body.activities ?? [])].sort((x, y) => String(x.createTime ?? '').localeCompare(String(y.createTime ?? '')));
    for (const a of acts) {
      const id = a.name || a.id || `${a.createTime}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const c = classifyActivity(a);
      if (c.prUrl) prUrl = c.prUrl;
      if (c.kind === 'agent' && c.text) {
        collected.push(c.text);
        options?.onEvent?.({ type: 'text', delta: c.text + '\n' });
      } else if ((c.kind === 'plan' || c.kind === 'progress') && c.text) {
        options?.onEvent?.({ type: 'reasoning', delta: c.text + '\n' });
      } else if (c.kind === 'completed') {
        done = true;
      } else if (c.kind === 'failed') {
        throw new Error(`Jules session failed: ${c.reason}`);
      }
    }
    if (!done) await sleep(POLL_INTERVAL_MS, options?.signal);
  }

  let text = collected.join('\n\n').trim();
  if (prUrl) text += `\n\nPull request: ${prUrl}`;
  if (session.url) text += `\n\nJules session: ${session.url}`;
  if (!done && !options?.signal?.aborted) {
    text += `\n\n(Jules is still working — it runs asynchronously. Check the session link for the final result.)`;
  }
  return { text: text || 'Jules session started.', usage: { inputTokens: 0, outputTokens: 0 }, output: [] };
}
