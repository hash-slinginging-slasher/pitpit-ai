import type { AgentConfig } from './config.js';
import {
  runAgentChain,
  runResilientChain,
  isAbortError,
  type ChatMessage,
  type AgentEvent,
  type RunOptions,
} from './agent.js';
import { brainContext, retrieveBrain, formatBrainContext } from './brain.js';
import { addTask, updateTask, loadBoard, deleteTask, isPlanEcho, isCorruptCard } from './board.js';
import { readAgents } from './config.js';

/**
 * Orchestration: a reliable "orchestrator" model plans a task into a checklist and
 * delegates each step to the coder chain (which is itself resilient — see
 * runResilientChain). After each step the orchestrator reviews the result, updates a
 * ledger, and may add steps or declare the task complete. Because the orchestrator is
 * meant to be a stable model (e.g. the local LLM, never rate-limited), the plan/ledger
 * survive while flaky free coders come and go.
 *
 * Only used when an orchestrator chain is configured; otherwise the caller runs the
 * coder chain directly.
 */

export interface LedgerStep {
  title: string;
  status: 'pending' | 'done' | 'failed';
  note?: string;
  cardId?: string; // linked Kanban card
}

export interface OrchestrateOptions extends RunOptions {
  onFailover?: (info: { from: string; to: string; index: number; error: string }) => void;
  onContinue?: (info: { model: string; leg: number; reason: 'step-cap' | 'handoff' }) => void;
  /** Hard cap on total executed steps (plan length can grow via review). Default 16. */
  maxTaskSteps?: number;
}

const shortName = (m: string) => (m || '').split('/').pop() || m;

/**
 * System prompt for a DIRECT "@orchestrator" conversation — the user talking to the scrum
 * master to ask about status/priorities, not kicking off a plan/execute run.
 */
export const ORCHESTRATOR_CHAT_SYSTEM = [
  'You are the ORCHESTRATOR (scrum master) for this project. The user is addressing you directly.',
  'Answer their question conversationally and concisely, grounded in the Kanban board state and',
  'project brain provided to you. You may assess progress, flag problems (e.g. junk, duplicate, or',
  'stale cards), recommend what to do next, and suggest reprioritizing. Do NOT write code or call',
  'tools — respond as the planner/manager. If the board looks corrupted or bloated, say so and',
  'suggest running "/board clean" or "/board clear".',
].join(' ');

/** Build the board + brain context block that grounds a direct @orchestrator question. */
export async function orchestratorAskContext(cwd: string, question: string): Promise<string> {
  const b = loadBoard(cwd);
  const open = b.tasks.filter((t) => t.status !== 'done');
  const boardSummary = b.tasks.length
    ? `Kanban board — ${b.tasks.length} cards (${b.tasks.length - open.length} done, ${open.length} open):\n` +
      b.tasks.slice(0, 60).map((t) => `- [${t.status}] ${t.title}${t.source ? ` (from ${t.source})` : ''}`).join('\n') +
      (b.tasks.length > 60 ? `\n…and ${b.tasks.length - 60} more` : '')
    : 'The Kanban board is empty.';
  const notes = await retrieveBrain(cwd, question).catch(() => []);
  const brain = notes.length ? `${formatBrainContext(notes)}\n\n---\n\n` : '';
  return `${brain}${boardSummary}\n\n---\n\nThe user asks the orchestrator: ${question}`;
}

const PLAN_INSTRUCTIONS = [
  'You are an ORCHESTRATOR. Break the user\'s coding task into a short, ordered checklist of',
  'concrete steps that a coder agent will execute one at a time.',
  'Rules: output ONLY a numbered list (between 1 and 8 steps). Each line is ONE actionable',
  'instruction, specific to this task. No preamble, no explanation, no code — just the list.',
  'Each step must be a concrete change to the code or files for THIS task (e.g. "add the',
  'PageControl interface in schema.ts", "generate the _meta endpoint in server.ts"). Do NOT',
  'include generic filler steps like "confirm the task", "identify the language", "set up the',
  'environment", "test the code", or "document" unless the task explicitly asks for them —',
  'those waste steps and make the plan look done before any real work happens.',
].join(' ');

const REVIEW_INSTRUCTIONS = [
  'You are an ORCHESTRATOR tracking progress on a coding task. You are given the overall task,',
  'the checklist with statuses, the step just attempted, and the coder\'s result for it.',
  'Decide the outcome and respond with EXACTLY these three lines and nothing else:',
  'STATUS: done | failed | task-complete',
  'NOTE: <one short line on what happened>',
  'NEXT: <one new step to add if something important is missing, otherwise the word none>',
  '(Use task-complete only when the ENTIRE task is finished.)',
].join('\n');

/** Extract a checklist from the planner's text. Tolerant; returns null if nothing usable. */
function parsePlan(text: string): string[] | null {
  const steps: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^(?:\d+[.)]|[-*])\s+(.*)$/);
    if (m && m[1].trim()) {
      const title = m[1].trim().replace(/\s+/g, ' ').slice(0, 200);
      if (!isPlanEcho(title)) steps.push(title); // drop instruction-echo lines
    }
  }
  return steps.length ? steps.slice(0, 8) : null;
}

function parseReview(text: string): { status: 'done' | 'failed' | 'task-complete'; note: string; next: string | null } {
  const statusLine = (text.match(/STATUS:\s*(.+)/i)?.[1] ?? '').trim().toLowerCase();
  const noteM = text.match(/NOTE:\s*(.+)/i);
  const nextM = text.match(/NEXT:\s*(.+)/i);
  // Only an EXPLICIT "task-complete" ends the whole plan. Weak reviewers routinely write
  // "complete"/"completed"/"done" to mean THIS STEP finished — treating that as whole-task
  // completion is what made the orchestrator bail after step 1. So "complete"/"done" alone →
  // this step is done (keep going); the task ends only on an unambiguous task-complete signal.
  let status: 'done' | 'failed' | 'task-complete' = 'done';
  if (/\bfail(ed|ure|ing)?\b|\berror\b|\bblocked\b/.test(statusLine)) status = 'failed';
  else if (/task[-_ ]?complete|entire task|whole task|all steps? (are )?(done|complete)/.test(statusLine))
    status = 'task-complete';
  const next = nextM && !/^(none|n\/a|-)?\.?$/i.test(nextM[1].trim()) ? nextM[1].trim().slice(0, 200) : null;
  return { status, note: (noteM?.[1] ?? '').trim().slice(0, 200), next };
}

/** One-shot orchestrator call (no tools) — used for planning and review. */
async function orchestratorSay(
  config: AgentConfig,
  chain: string[],
  input: string,
  instructions: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await runAgentChain(config, chain, input, { noTools: true, instructions, signal });
  return (res.text || '').trim();
}

function ledgerView(task: string, ledger: LedgerStep[]): string {
  const mark = (s: LedgerStep) => (s.status === 'done' ? '[x]' : s.status === 'failed' ? '[!]' : '[ ]');
  return (
    `TASK: ${task}\n\nCHECKLIST:\n` +
    ledger.map((s, i) => `${i + 1}. ${mark(s)} ${s.title}${s.note ? ` — ${s.note}` : ''}`).join('\n')
  );
}

/**
 * Run a task under orchestration. Returns the same shape as the coder runners
 * ({ text, usage, model, failedOver }) plus the final ledger.
 */
export async function runOrchestrated(
  config: AgentConfig,
  orchestratorChain: string[],
  coderChain: string[],
  task: string,
  options?: OrchestrateOptions,
) {
  const emit = (e: AgentEvent) => options?.onEvent?.(e);
  const usage = { inputTokens: 0, outputTokens: 0 };
  const abortCheck = () => {
    if (options?.signal?.aborted) {
      const e: any = new Error('Aborted by user');
      e.name = 'AbortError';
      throw e;
    }
  };

  const boardCwd = process.cwd();

  // 0) RESUME? If the board already holds open orchestrator cards (a plan derived earlier from
  // the PRD/brain), work down THOSE instead of re-planning — the board is the source of truth,
  // and the cards carry their provenance (source PRD + planId). Only fall back to fresh planning
  // when there's nothing open to continue.
  let ledger: LedgerStep[] = [];
  let planId = '';
  let source: string | undefined;
  let resumed = false;
  try {
    const openAll = loadBoard(boardCwd).tasks.filter(
      (t) => t.status !== 'done' && (t.by === 'orchestrator' || !!t.planId),
    );
    // Self-heal: a weak planner echoes its instructions back, saves error notices ("Add 10
    // credits…"), etc., which get stored as cards and then replayed every turn. Those are never
    // real tasks, so delete them. (For deeper cleanup incl. boilerplate filler, run /board clean.)
    const open: typeof openAll = [];
    for (const t of openAll) {
      if (isCorruptCard(t.title)) {
        try { deleteTask(boardCwd, t.id); } catch { /* ignore */ }
      } else {
        open.push(t);
      }
    }
    if (open.length) {
      ledger = open.map((t) => ({ title: t.title, status: 'pending' as const, cardId: t.id }));
      planId = open.find((t) => t.planId)?.planId ?? '';
      source = open.find((t) => t.source)?.source;
      resumed = true;
    }
  } catch {
    /* board is best-effort */
  }

  // 1) PLAN (only when not resuming) — informed by the project brain, where the PRD lives.
  // The top retrieved note becomes the plan's `source`, and every card is stamped with the
  // shared planId so the whole chain (PRD → plan → card) is traceable and resumable.
  if (!resumed) {
    abortCheck();
    const notes = await retrieveBrain(boardCwd, task).catch(() => []);
    source = notes[0]?.name; // e.g. the PRD note this plan is derived from
    const planBrain = formatBrainContext(notes);
    let plan: string[] | null = null;
    try {
      const planInput = (planBrain ? `${planBrain}\n\n---\n\n` : '') + task;
      const planText = await orchestratorSay(config, orchestratorChain, planInput, PLAN_INSTRUCTIONS, options?.signal);
      plan = parsePlan(planText);
    } catch (err) {
      if (isAbortError(err, options?.signal)) throw err;
      // planning failed → fall through to a single-step plan (still resilient on coders)
    }
    planId = 'plan_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    ledger = (plan ?? [task]).map((title) => ({ title, status: 'pending' }));
    // Scrum master: put each planned step on the Kanban board as a To Do card, stamped with
    // its provenance (source PRD + planId).
    try {
      for (const s of ledger) s.cardId = addTask(boardCwd, s.title, { status: 'todo', by: 'orchestrator', planId, source }).id;
    } catch {
      /* board is best-effort */
    }
  }

  emit({ type: 'plan', steps: ledger.map((s) => s.title), orchestrator: orchestratorChain[0] ?? '', resumed, source });

  const setCard = (step: LedgerStep, status: 'todo' | 'pending' | 'done', detail?: string) => {
    if (step.cardId) { try { updateTask(boardCwd, step.cardId, { status, ...(detail ? { detail } : {}) }); } catch { /* ignore */ } }
  };

  // 2) EXECUTE + REVIEW, step by step
  const maxSteps = options?.maxTaskSteps ?? 16;
  let executed = 0;
  let lastText = '';
  let lastModel = coderChain[0] ?? '';
  let taskComplete = false;

  for (let i = 0; i < ledger.length && executed < maxSteps && !taskComplete; i++) {
    const step = ledger[i];
    if (step.status !== 'pending') continue;
    abortCheck();
    executed++;
    emit({ type: 'step', phase: 'start', index: i, total: ledger.length, title: step.title });
    setCard(step, 'pending'); // scrum master: move card to In Progress

    // Delegate the step to the (resilient) coder chain, with the ledger + the brain notes
    // relevant to THIS step (the orchestrator handing project details down to the coder).
    const stepBrain = await brainContext(process.cwd(), `${task}\n${step.title}`);
    const stepPrompt =
      (stepBrain ? `${stepBrain}\n\n---\n\n` : '') +
      `${ledgerView(task, ledger)}\n\n` +
      `Now do STEP ${i + 1} only: ${step.title}\n` +
      `The files on disk already reflect any earlier steps. Focus on THIS step; when done, ` +
      `briefly state what you changed. Do not restate the whole plan.`;

    // Re-read the coder chain each step so coders demoted for rate-limits/failures earlier in
    // THIS task drop to the bottom and aren't re-tried from the top every step (and so any
    // chain edits you make mid-run are picked up).
    const currentCoders = (() => {
      try { const c = readAgents().coder; return c.length ? c : coderChain; } catch { return coderChain; }
    })();
    try {
      const res = await runResilientChain(config, currentCoders, stepPrompt, {
        signal: options?.signal,
        onEvent: (e) => emit(e), // stream the coder's text/tool events through
        onFailover: options?.onFailover,
        onContinue: options?.onContinue,
      });
      lastText = res.text || lastText;
      lastModel = res.model || lastModel;
      if (res.usage) {
        usage.inputTokens += res.usage.inputTokens ?? 0;
        usage.outputTokens += res.usage.outputTokens ?? 0;
      }
      step.status = 'done';
    } catch (err: any) {
      if (isAbortError(err, options?.signal)) throw err;
      // A thrown error here means EVERY coder in the chain failed this step (all rate-limited
      // or erroring). Re-trying more steps against the same exhausted chain just repeats the
      // failures, so stop and surface it as action-required instead of cycling.
      step.status = 'failed';
      step.note = (err?.message ?? String(err)).slice(0, 160);
      setCard(step, 'pending', 'all coders failed');
      emit({ type: 'step', phase: 'failed', index: i, total: ledger.length, title: step.title, note: 'all coders failed' });
      const e: any = new Error(
        `Every coder failed step ${i + 1} — likely rate limits or invalid model ids. ` +
          `Fix the coder chain in Models & settings (remove models returning 403/404/413, wait out rate limits). ` +
          `Last error: ${(err?.message ?? String(err)).slice(0, 140)}`,
      );
      throw e; // bail the whole orchestration; the CLI/chat renders this in red
    }

    // 3) REVIEW: let the orchestrator assess and (maybe) adjust the plan.
    abortCheck();
    try {
      const reviewInput =
        `${ledgerView(task, ledger)}\n\n` +
        `STEP JUST ATTEMPTED: ${i + 1}. ${step.title}\n` +
        `CODER RESULT:\n${(lastText || '(no output)').slice(0, 2000)}`;
      const reviewText = await orchestratorSay(config, orchestratorChain, reviewInput, REVIEW_INSTRUCTIONS, options?.signal);
      const review = parseReview(reviewText);
      // The coder returned (didn't throw), so the step ran; the review decides done vs failed.
      step.status = review.status === 'failed' ? 'failed' : 'done';
      if (review.note) step.note = review.note;
      if (review.next && ledger.length < maxSteps) {
        const added: LedgerStep = { title: review.next, status: 'pending' };
        try { added.cardId = addTask(boardCwd, added.title, { status: 'todo', by: 'orchestrator', planId, source }).id; } catch { /* ignore */ }
        ledger.push(added);
      }
      // Honor an early "task-complete" only after real progress. A weak local reviewer will
      // otherwise declare victory after step 1 of a multi-step plan (the exact symptom users
      // hit). Single-step plans may complete immediately; multi-step plans need ≥2 executed.
      if (review.status === 'task-complete' && (ledger.length <= 1 || executed >= 2)) taskComplete = true;
    } catch (err) {
      if (isAbortError(err, options?.signal)) throw err;
      // review failed → keep the coder's own verdict (done/failed) and continue
    }

    // Scrum master: mark the card done, or leave it In Progress with the failure note.
    if (step.status === 'failed') setCard(step, 'pending', `⚠ ${step.note || 'failed'}`);
    else setCard(step, 'done', step.note);
    emit({ type: 'step', phase: step.status === 'failed' ? 'failed' : 'done', index: i, total: ledger.length, title: step.title, note: step.note });
  }

  // 4) SUMMARY
  const done = ledger.filter((s) => s.status === 'done').length;
  const failed = ledger.filter((s) => s.status === 'failed').length;
  const header = taskComplete
    ? `Task complete — ${done}/${ledger.length} steps done.`
    : `Ran ${executed} step(s): ${done} done${failed ? `, ${failed} failed` : ''}${executed >= maxSteps ? ' (step budget reached)' : ''}.`;
  const text = `${header}\n\n${ledgerView(task, ledger)}${lastText ? `\n\n---\n${lastText}` : ''}`;
  return { text, usage, model: lastModel, failedOver: false, ledger, stopReason: 'completed' as const };
}
