import { readdirSync } from 'fs';
import { join, relative, sep } from 'path';

/**
 * A compact map of a project's files, injected into agent context so coders and the
 * orchestrator KNOW what exists instead of re-globbing/listing to discover files every turn.
 * Skips heavy/vendored/tooling directories and caps the count so it stays token-cheap.
 */

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.codigo', '.skills', 'dist', 'build', 'out', 'coverage', '.next',
  '.nuxt', '.svelte-kit', 'vendor', '__pycache__', '.venv', 'venv', 'env', 'target', '.cache',
  '.turbo', '.parcel-cache', 'tmp', 'temp', '.idea', '.vscode', '.pytest_cache', '.mypy_cache',
  'bin', 'obj', '.gradle', 'Pods', '.terraform',
]);

/** Collect project-relative file paths (posix-style), skipping ignored dirs. */
function collectFiles(cwd: string, maxFiles: number, maxDepth: number): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number) => {
    if (truncated || depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Directories first, then files; alphabetical within each — stable, readable output.
    entries.sort((a, b) =>
      a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
    );
    for (const e of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue; // skip vendored/tooling dirs
        walk(join(dir, e.name), depth + 1);
      } else {
        files.push(relative(cwd, join(dir, e.name)).split(sep).join('/'));
      }
    }
  };
  walk(cwd, 0);
  return { files: files.sort(), truncated };
}

/**
 * Render the project's file listing as an injectable context block. Returns '' for an empty
 * or unreadable directory. The instruction is deliberately blunt: agents should treat this as
 * ground truth and NOT waste turns re-discovering files.
 */
export function projectMap(cwd: string, opts?: { maxFiles?: number; maxDepth?: number }): string {
  const maxFiles = opts?.maxFiles ?? 250;
  const maxDepth = opts?.maxDepth ?? 8;
  const { files, truncated } = collectFiles(cwd, maxFiles, maxDepth);
  if (!files.length) return '';
  return (
    `# Project files (${files.length}${truncated ? '+' : ''})\n` +
    `This is the current file listing for this project — you already know what exists. Open the ` +
    `files you need directly with file_read; do NOT run list_dir/glob just to discover what files ` +
    `are here (only glob/grep when you need to search file CONTENTS or paths not shown below).\n` +
    files.map((f) => `- ${f}`).join('\n') +
    (truncated ? `\n- …(listing capped at ${maxFiles}; use glob for anything not shown)` : '')
  );
}
