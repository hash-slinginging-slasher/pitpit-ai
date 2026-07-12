/**
 * Tolerant find-and-replace for the edit tools. Weak models routinely produce an old_string
 * that is *almost* right — wrong line endings (\r\n vs \n) or trailing whitespace — which made
 * byte-exact matching fail with "old_string not found". This matches in layers, requiring a
 * UNIQUE match, and preserves the file's original line endings on write:
 *   1. exact
 *   2. line-ending normalized (\r\n → \n)
 *   3. line-block, trailing-whitespace tolerant (indentation still must match, so we never
 *      silently re-indent code — important for Python et al.)
 */

export type EditResult =
  | { ok: true; content: string; method: 'exact' | 'eol' | 'whitespace' }
  | { ok: false; reason: 'not_found' | 'multiple'; count: number; hint?: string };

function usesCRLF(s: string): boolean {
  return /\r\n/.test(s);
}
const toLF = (s: string): string => s.replace(/\r\n/g, '\n');

export function robustReplace(content: string, oldStr: string, newStr: string): EditResult {
  // 1) Exact.
  const exact = content.split(oldStr).length - 1;
  if (exact === 1) return { ok: true, content: content.replace(oldStr, () => newStr), method: 'exact' };
  if (exact > 1) return { ok: false, reason: 'multiple', count: exact };

  const crlf = usesCRLF(content);
  const fromLF = (s: string): string => (crlf ? s.replace(/\n/g, '\r\n') : s);
  const cLF = toLF(content);
  const oLF = toLF(oldStr);
  const nLF = toLF(newStr);

  // 2) Line-ending normalized exact.
  const eolCount = cLF.split(oLF).length - 1;
  if (eolCount === 1) return { ok: true, content: fromLF(cLF.replace(oLF, () => nLF)), method: 'eol' };
  if (eolCount > 1) return { ok: false, reason: 'multiple', count: eolCount };

  // 3) Whole-line block match, tolerant of trailing whitespace (leading indentation preserved).
  const cLines = cLF.split('\n');
  const oLines = oLF.replace(/\n$/, '').split('\n');
  const stripTrailing = (l: string): string => l.replace(/[ \t]+$/, '');
  const cN = cLines.map(stripTrailing);
  const oN = oLines.map(stripTrailing);
  const hits: number[] = [];
  for (let i = 0; i + oN.length <= cN.length; i++) {
    let match = true;
    for (let j = 0; j < oN.length; j++) {
      if (cN[i + j] !== oN[j]) {
        match = false;
        break;
      }
    }
    if (match) hits.push(i);
  }
  if (hits.length === 1) {
    const i = hits[0];
    const newLines = nLF.replace(/\n$/, '').split('\n');
    const rebuilt = [...cLines.slice(0, i), ...newLines, ...cLines.slice(i + oN.length)].join('\n');
    return { ok: true, content: fromLF(rebuilt), method: 'whitespace' };
  }
  if (hits.length > 1) return { ok: false, reason: 'multiple', count: hits.length };

  // Not found — surface a hint so the model can recover instead of looping.
  const trimmedNew = nLF.trim();
  const hint = trimmedNew && cLF.includes(trimmedNew)
    ? 'the replacement text already appears in the file — this edit may already be applied.'
    : undefined;
  return { ok: false, reason: 'not_found', count: 0, hint };
}
