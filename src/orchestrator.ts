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
import { projectMap } from './projectmap.js';
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

type Usage = { inputTokens: number; outputTokens: number };

/** Accumulate a call's token usage into a running total (both fields optional/missing-safe). */
function addUsage(acc: Usage, u?: { inputTokens?: number; outputTokens?: number }): void {
  if (!u) return;
  acc.inputTokens += u.inputTokens ?? 0;
  acc.outputTokens += u.outputTokens ?? 0;
}

/** One-shot orchestrator call (no tools) — used for planning, review, and conversation.
 * Returns the reply text AND the orchestrator model's token usage so callers can count it
 * (previously the orchestrator's own tokens were dropped, showing "0 in / 0 out"). */
async function orchestratorSay(
  config: AgentConfig,
  chain: string[],
  input: string | ChatMessage[],
  instructions: string,
  signal?: AbortSignal,
): Promise<{ text: string; usage?: Usage }> {
  const res = await runAgentChain(config, chain, input, { noTools: true, instructions, signal });
  return { text: (res.text || '').trim(), usage: res.usage ?? undefined };
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
      // Don't tunnel on old cards: if the user gave a REAL instruction this turn (not just
      // "proceed"/"continue"), handle it FIRST as a new top-priority step, then continue the
      // board. Otherwise a fresh request (e.g. "snake.py fails: No module named pygame") would
      // be ignored while the orchestrator replays stale cards.
      const trivial = /^(proceed|continue|next|go( on)?|keep going|resume|carry on|ok(ay)?|yes|y|do it|please continue|continue\.?)\s*$/i;
      const t = (task || '').trim();
      if (t && !trivial.test(t)) {
        const first: LedgerStep = { title: t.slice(0, 200), status: 'pending' };
        try { first.cardId = addTask(boardCwd, first.title, { status: 'todo', by: 'orchestrator', planId, source }).id; } catch { /* ignore */ }
        ledger.unshift(first);
      }
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
    // Enumerate the project's files so the planner references real files (and the coder isn't
    // asked to "find" things that are already listed here).
    const map = projectMap(boardCwd);
    let plan: string[] | null = null;
    try {
      const planInput = [map, planBrain, task].filter(Boolean).join('\n\n---\n\n');
      const planSaid = await orchestratorSay(config, orchestratorChain, planInput, PLAN_INSTRUCTIONS, options?.signal);
      addUsage(usage, planSaid.usage);
      plan = parsePlan(planSaid.text);
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
      const reviewSaid = await orchestratorSay(config, orchestratorChain, reviewInput, REVIEW_INSTRUCTIONS, options?.signal);
      addUsage(usage, reviewSaid.usage);
      const review = parseReview(reviewSaid.text);
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

// ---------------------------------------------------------------------------
// Conversational orchestrator — you talk to the orchestrator (a manager) and it
// delegates coding to coder subagents. Uses a text protocol (DELEGATE: lines) rather than
// function-calling, because the orchestrator may be a weak/local model that handles a simple
// line protocol far more reliably than tool schemas.
// ---------------------------------------------------------------------------

const CONVO_SYSTEM = [
  'You are the ORCHESTRATOR — a hands-on engineering manager for this project. You talk WITH the',
  'user and get work done by delegating to CODER SUBAGENTS. You do NOT write, edit, or run code',
  'yourself; the coders have the file/shell tools.',
  '',
  'To delegate a task, put it on its OWN line beginning with "DELEGATE:" — for example:',
  'DELEGATE: In snake.py, install any missing dependencies (e.g. pip install pygame) and make',
  '`python snake.py` run without errors; report what you changed.',
  'Rules for delegation:',
  '- Each DELEGATE line is a single, self-contained instruction. A coder sees ONLY that line plus',
  '  the project files — give it enough detail to act without the rest of the conversation.',
  '- You may issue several DELEGATE lines to run in order. After they run you will see each',
  "  coder's result and can respond to the user or delegate follow-ups.",
  '- Prefer delegating the smallest concrete piece that moves the task forward.',
  '',
  'When the user is chatting, asking a question, or the work is done, reply normally with NO',
  'DELEGATE line. Everything you write that is not a DELEGATE line is shown to the user as your',
  'message, so be concise and clear. Do not narrate a plan you are not going to delegate.',
].join('\n');

/** Pull "DELEGATE: …" tasks out of the orchestrator's reply. */
function parseDelegations(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.trim().match(/^DELEGATE:\s*(.+)$/i);
    if (m && m[1].trim()) out.push(m[1].trim().slice(0, 400));
  }
  return out;
}
/** The orchestrator's user-facing message = its reply minus the DELEGATE lines. */
function stripDelegations(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^\s*DELEGATE:/i.test(l))
    .join('\n')
    .trim();
}

/**
 * Run one conversational turn: the orchestrator talks and delegates to coder subagents in a
 * loop until it replies with no further delegation. Streams the orchestrator's messages and the
 * coders' work through options.onEvent. Returns the final orchestrator message (for history).
 */
export async function runConversationalOrchestrator(
  config: AgentConfig,
  orchestratorChain: string[],
  coderChain: string[],
  input: string | ChatMessage[],
  options?: OrchestrateOptions,
) {
  const emit = (e: AgentEvent) => options?.onEvent?.(e);
  const cwd = process.cwd();
  const usage = { inputTokens: 0, outputTokens: 0 };
  const abortCheck = () => {
    if (options?.signal?.aborted) {
      const e: any = new Error('Aborted by user');
      e.name = 'AbortError';
      throw e;
    }
  };

  // Working copy of the conversation (the caller keeps the clean user/assistant history).
  const messages: ChatMessage[] = typeof input === 'string' ? [{ role: 'user', content: input }] : [...input];

  // Ground the orchestrator in the project (file map + brain relevant to the latest ask).
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const map = projectMap(cwd);
  const brain = await brainContext(cwd, lastUser).catch(() => '');
  const instructions = [CONVO_SYSTEM, map, brain].filter(Boolean).join('\n\n');

  const maxRounds = options?.maxTaskSteps ?? 8;
  let finalText = '';

  for (let round = 0; round < maxRounds; round++) {
    abortCheck();
    const said = await orchestratorSay(config, orchestratorChain, messages, instructions, options?.signal);
    addUsage(usage, said.usage);
    const reply = said.text;
    const delegations = parseDelegations(reply);
    const speech = stripDelegations(reply);
    if (speech) emit({ type: 'text', delta: (round ? '\n\n' : '') + speech + '\n' });
    messages.push({ role: 'assistant', content: reply });
    if (speech) finalText = speech;
    if (!delegations.length) break;

    // Re-read the coder chain each round so demotions/prunes/edits are picked up.
    const coders = (() => {
      try {
        const c = readAgents().coder;
        return c.length ? c : coderChain;
      } catch {
        return coderChain;
      }
    })();

    for (const task of delegations) {
      abortCheck();
      emit({ type: 'delegate', task });
      // Mirror the delegation onto the board (visible in the Board tab) as In Progress → Done.
      let cardId: string | undefined;
      try {
        cardId = addTask(cwd, task, { status: 'pending', by: 'orchestrator' }).id;
      } catch {
        /* board best-effort */
      }
      const coderPrompt =
        `You are a CODER SUBAGENT. The orchestrator has delegated this task to you — complete it ` +
        `fully using your tools.\n\nTASK: ${task}\n\nThe project's files are listed in your system ` +
        `prompt. If a dependency is missing, install it (pip/npm) and retry. When done, briefly ` +
        `report what you changed and any commands you ran and their outcome.`;
      let resultText = '';
      try {
        const res = await runResilientChain(config, coders, coderPrompt, {
          signal: options?.signal,
          onEvent: (e) => emit(e),
          onFailover: options?.onFailover,
          onContinue: options?.onContinue,
        });
        resultText = (res.text || '(no textual output)').slice(0, 2500);
        if (res.usage) {
          usage.inputTokens += res.usage.inputTokens ?? 0;
          usage.outputTokens += res.usage.outputTokens ?? 0;
        }
      } catch (err: any) {
        if (isAbortError(err, options?.signal)) throw err;
        resultText = `FAILED: ${(err?.message ?? String(err)).slice(0, 240)}`;
      }
      if (cardId) {
        try {
          updateTask(cwd, cardId, { status: 'done', detail: resultText.slice(0, 160) });
        } catch {
          /* ignore */
        }
      }
      // Feed the coder's result back so the orchestrator can review and respond/delegate more.
      messages.push({ role: 'user', content: `[result from the coder for "${task.slice(0, 120)}"]\n${resultText}` });
    }
  }

  return {
    text: finalText || 'Done.',
    usage,
    model: orchestratorChain[0] ?? '',
    failedOver: false,
    conversational: true as const,
    stopReason: 'completed' as const,
  };
}
