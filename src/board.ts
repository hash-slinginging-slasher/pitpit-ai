import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

/**
 * Per-project Kanban board at `.codigo/board.json`. Three columns — todo / pending / done —
 * that the orchestrator maintains as a scrum master (a card per plan step, moved as it runs)
 * and that you manage in the Board tab. Versioned in git like the brain.
 */

export type TaskStatus = 'todo' | 'pending' | 'done';

export interface Task {
  id: string;
  title: string;
  detail?: string;
  status: TaskStatus;
  by?: string; // 'orchestrator' | 'you' | 'agent'
  source?: string; // provenance: brain note / PRD the plan was derived from (e.g. "prd/agent-debug")
  planId?: string; // groups all cards created from one orchestrator plan
  created: number;
  updated: number;
}

export interface Board {
  tasks: Task[];
}

export function boardPath(cwd: string): string {
  return join(cwd, '.codigo', 'board.json');
}

export function loadBoard(cwd: string): Board {
  const p = boardPath(cwd);
  if (!existsSync(p)) return { tasks: [] };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    return { tasks: Array.isArray(raw?.tasks) ? raw.tasks : [] };
  } catch {
    return { tasks: [] };
  }
}

export function saveBoard(cwd: string, board: Board): void {
  const p = boardPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ tasks: board.tasks ?? [] }, null, 2));
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Add a task; returns it. */
export function addTask(
  cwd: string,
  title: string,
  opts?: { detail?: string; status?: TaskStatus; by?: string; source?: string; planId?: string },
): Task {
  const board = loadBoard(cwd);
  const now = Date.now();
  const task: Task = {
    id: genId(),
    title: title.slice(0, 200),
    detail: opts?.detail,
    status: opts?.status ?? 'todo',
    by: opts?.by ?? 'you',
    source: opts?.source,
    planId: opts?.planId,
    created: now,
    updated: now,
  };
  board.tasks.push(task);
  saveBoard(cwd, board);
  return task;
}

/** Patch a task by id (status/title/detail). No-op if not found. */
export function updateTask(cwd: string, id: string, patch: Partial<Pick<Task, 'title' | 'detail' | 'status'>>): Task | null {
  const board = loadBoard(cwd);
  const t = board.tasks.find((x) => x.id === id);
  if (!t) return null;
  Object.assign(t, patch, { updated: Date.now() });
  saveBoard(cwd, board);
  return t;
}

/** Mark the most recent matching-title task done (used by the board_task tool). */
export function completeTaskByTitle(cwd: string, title: string): Task | null {
  const board = loadBoard(cwd);
  const t = [...board.tasks].reverse().find((x) => x.status !== 'done' && x.title.toLowerCase().includes(title.toLowerCase()));
  if (!t) return null;
  t.status = 'done';
  t.updated = Date.now();
  saveBoard(cwd, board);
  return t;
}

export function deleteTask(cwd: string, id: string): void {
  const board = loadBoard(cwd);
  board.tasks = board.tasks.filter((x) => x.id !== id);
  saveBoard(cwd, board);
}

// --- Junk-card detection: self-heal a board polluted by a weak orchestrator ---
// A weak planner echoes its own prompt, saves error notices, or emits boilerplate as "tasks".
// Those cards then get resumed and replayed forever. These predicates classify them.

/** A card that's really the planner echoing its instructions back — never a real task. */
export function isPlanEcho(title: string): boolean {
  return /^you are an orchestrator\b|output only a numbered list|one actionable instruction|do not include (preamble|generic|filler)|break the user['’]?s (coding )?task|no preamble|executable by a coder agent|do not respond to questions about|between \d+ and \d+ steps|concrete change to the code or files|focus only on the current user/i.test(
    title.trim(),
  );
}

/** A card that's actually an error/notice the model emitted (rate limit / out of credit). */
export function isErrorNoise(title: string): boolean {
  return /\badd \d+ credits?\b|unlock \d+ free|free.?models.?per.?day|rate.?limit|out of credit|quota (exceeded|reached)|insufficient (credit|balance|funds)/i.test(
    title,
  );
}

/** Boilerplate meta-steps / hallucinated PM-tool references a weak planner emits as filler. */
export function isGenericFiller(title: string): boolean {
  return /break the task into smaller|(identify|determine) (the )?(required )?(programming language|tools)|set up (the )?(development )?environment|write the initial code (structure|pseudocode)|test the code with sample inputs|debug and (refine|fix) (the |any )?(code|issues)|document the code and finalize|deliver the final working|confirm the specific coding task|\bjira\b|\btrello\b|azure devops|project management tool/i.test(
    title,
  );
}

/** Unambiguous corruption — safe to auto-delete during resume (never a legitimate task). */
export function isCorruptCard(title: string): boolean {
  return isPlanEcho(title) || isErrorNoise(title);
}

/** All junk incl. borderline filler — used by the user-invoked "/board clean" command. */
export function isJunkCard(title: string): boolean {
  return isCorruptCard(title) || isGenericFiller(title);
}

/** Remove cards. mode 'all' wipes the board; 'clean' drops junk cards. Returns removed titles. */
export function cleanBoard(cwd: string, mode: 'all' | 'clean'): string[] {
  const board = loadBoard(cwd);
  const removed: string[] = [];
  if (mode === 'all') {
    removed.push(...board.tasks.map((t) => t.title));
    saveBoard(cwd, { tasks: [] });
  } else {
    const kept = board.tasks.filter((t) => {
      const junk = isJunkCard(t.title);
      if (junk) removed.push(t.title);
      return !junk;
    });
    saveBoard(cwd, { tasks: kept });
  }
  return removed;
}
