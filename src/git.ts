import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Thin git wrapper for the CLI's auto-commit feature. All commands run in `cwd`
 * (the project being coded in, never the app dir). Every function is best-effort:
 * callers treat a thrown error as "git unavailable / nothing committed" and carry on.
 */

/** Fallback identity so commits succeed even when the user has no global git config. */
const FALLBACK_IDENTITY = [
  '-c', 'user.name=OpenRouter Coding Agent',
  '-c', 'user.email=coder@localhost',
];

/** Commit authors used to distinguish who made a change (shown in file history). */
export const AGENT_AUTHOR = { name: 'Codigo (agent)', email: 'agent@codigo.local' };
export const USER_AUTHOR = { name: 'Codigo (you)', email: 'you@codigo.local' };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/** Is the `git` executable available on PATH? Cached after the first check. */
let gitAvailable: boolean | null = null;
export async function hasGit(): Promise<boolean> {
  if (gitAvailable !== null) return gitAvailable;
  try {
    await execFileAsync('git', ['--version'], { windowsHide: true });
    gitAvailable = true;
  } catch {
    gitAvailable = false;
  }
  return gitAvailable;
}

/** True if `dir` is inside a git work tree. */
export async function isRepo(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/** `git init` in `dir`. Returns true on success. */
export async function initRepo(dir: string): Promise<boolean> {
  try {
    await git(dir, ['init']);
    return true;
  } catch {
    return false;
  }
}

/** True if the work tree has any staged/unstaged/untracked changes. */
export async function hasChanges(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ['status', '--porcelain']);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export interface CommitResult {
  committed: boolean;
  hash?: string;
  files?: number;
  reason?: string;
}

/**
 * Stage everything in `dir` and commit with `subject` (+ optional `body`).
 * No-op (committed:false) when there is nothing to commit. Uses a fallback
 * identity so it never fails on an unconfigured git.
 */
export async function commitAll(
  dir: string,
  subject: string,
  body?: string,
  author?: { name: string; email: string },
): Promise<CommitResult> {
  try {
    await git(dir, ['add', '-A']);
    // What actually got staged? (name-status doubles as the commit body.)
    const nameStatus = (await git(dir, ['diff', '--cached', '--name-status'])).trim();
    if (!nameStatus) return { committed: false, reason: 'no changes' };
    const files = nameStatus.split('\n').filter(Boolean).length;

    // Default the body to the list of changed files if the caller didn't supply one.
    const finalBody = body ?? nameStatus;
    const identity = author ? ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`] : FALLBACK_IDENTITY;
    await git(dir, [...identity, 'commit', '-m', subject, '-m', finalBody]);

    const hash = (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim();
    return { committed: true, hash, files };
  } catch (err: any) {
    return { committed: false, reason: err?.message ?? String(err) };
  }
}

export interface FileVersion {
  hash: string;
  author: string; // 'agent' | 'you' | raw author name
  date: string; // ISO
  subject: string;
}

/** Map a commit author name to a short label for the UI. */
function authorLabel(name: string): string {
  if (name === AGENT_AUTHOR.name) return 'agent';
  if (name === USER_AUTHOR.name) return 'you';
  return name;
}

/** Version history (commits that touched `relPath`), newest first. `relPath` is repo-relative. */
export async function fileHistory(dir: string, relPath: string, n = 60): Promise<FileVersion[]> {
  try {
    const out = await git(dir, [
      'log', `-n${n}`, '--follow', '--format=%H%x1f%an%x1f%aI%x1f%s', '--', relPath,
    ]);
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [hash, author, date, subject] = l.split('\x1f');
        return { hash, author: authorLabel(author ?? ''), date: date ?? '', subject: subject ?? '' };
      });
  } catch {
    return [];
  }
}

/** Contents of `relPath` at commit `hash`. Throws if the path didn't exist there. */
export async function showFileAt(dir: string, relPath: string, hash: string): Promise<string> {
  // Forward slashes for the git pathspec even on Windows.
  return git(dir, ['show', `${hash}:${relPath.replace(/\\/g, '/')}`]);
}

/** True if the working file differs from HEAD (uncommitted local changes). */
export async function fileDirty(dir: string, relPath: string): Promise<boolean> {
  try {
    const out = await git(dir, ['status', '--porcelain', '--', relPath]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Parse the GitHub owner/repo of a repo's `origin` remote, or null if there is no
 * origin or it isn't a GitHub URL. Handles both https and ssh remote forms.
 */
export async function remoteGithubSlug(dir: string): Promise<{ owner: string; repo: string } | null> {
  try {
    const url = (await git(dir, ['remote', 'get-url', 'origin'])).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
    return m ? { owner: m[1], repo: m[2] } : null;
  } catch {
    return null;
  }
}

/** Current branch name in `dir`, or '' if unknown/detached. */
export async function currentBranch(dir: string): Promise<string> {
  try {
    return (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim().replace(/^HEAD$/, '');
  } catch {
    return '';
  }
}

/** Subjects of the most recent `n` commits, newest first. Empty if none / not a repo. */
export async function recentCommits(dir: string, n = 5): Promise<string[]> {
  try {
    const out = await git(dir, ['log', `-n${n}`, '--pretty=format:%s']);
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
