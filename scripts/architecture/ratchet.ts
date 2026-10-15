// Applies the ratchet allowlist to the checker's findings: a listed file may shrink or
// vanish but never grow, and a listed rule break is tolerated until its step removes
// it (util, ADR 059).

import { lineCount, type SourceFile, type Violation } from './source-file';

/** A file allowed over its size limit for now, at its line count when it was listed. */
export interface SizeEntry {
  lines: number;
  /** The refactor step that brings the file under its limit. */
  step: string;
}

/** What the refactor still tolerates, and whether stale entries fail. */
export interface Allowlist {
  /**
   * False while the server and client branches are apart, so a file the other branch
   * moved does not fail; true once they merge and the lists are emptied.
   */
  strict: boolean;
  /** Oversized files by path. */
  sizes: Readonly<Record<string, SizeEntry>>;
  /** Rule breaks by violation key, each with the step that removes it. */
  rules: Readonly<Record<string, string>>;
}

/** An allowlist that tolerates nothing, for fixture tests. */
export const EMPTY_ALLOWLIST: Allowlist = { strict: true, sizes: {}, rules: {} };

function allowSize(violation: Violation, entry: SizeEntry | undefined): Violation | null {
  if (entry === undefined) return violation;
  if ((violation.lines ?? 0) <= entry.lines) return null;
  return {
    ...violation,
    message: `${violation.file} grew from ${entry.lines} to ${violation.lines} lines; an allowlisted file may only shrink (${entry.step})`,
  };
}

function stale(file: string, key: string, why: string): Violation {
  return {
    rule: 'stale-allowlist',
    file,
    key: `stale-allowlist ${key}`,
    message: `allowlist entry '${key}' ${why}`,
  };
}

/** Allowlist entries that no longer match anything; reported only in strict mode. */
function staleEntries(
  violations: readonly Violation[],
  files: readonly SourceFile[],
  allowlist: Allowlist,
): Violation[] {
  const texts = new Map(files.map((file) => [file.path, file.text]));
  const oversized = new Set(violations.filter((v) => v.rule === 'size').map((v) => v.file));
  const keys = new Set(violations.map((violation) => violation.key));
  const out: Violation[] = [];
  for (const [file, entry] of Object.entries(allowlist.sizes)) {
    const text = texts.get(file);
    if (text === undefined) out.push(stale(file, `size ${file}`, 'names a missing file'));
    else if (!oversized.has(file)) {
      out.push(stale(file, `size ${file}`, `is within its limit now (${lineCount(text)} lines)`));
    } else if (lineCount(text) < entry.lines) {
      out.push(stale(file, `size ${file}`, `shrank to ${lineCount(text)} lines; lower the count`));
    }
  }
  for (const key of Object.keys(allowlist.rules)) {
    if (!keys.has(key)) out.push(stale(key.split(' ')[1] ?? key, key, 'matches no violation'));
  }
  return out;
}

/** The violations the allowlist does not cover, plus its stale entries when strict. */
export function applyAllowlist(
  violations: readonly Violation[],
  files: readonly SourceFile[],
  allowlist: Allowlist,
): Violation[] {
  const remaining: Violation[] = [];
  for (const violation of violations) {
    const kept =
      violation.rule === 'size'
        ? allowSize(violation, allowlist.sizes[violation.file])
        : allowlist.rules[violation.key] === undefined
          ? violation
          : null;
    if (kept !== null) remaining.push(kept);
  }
  return allowlist.strict
    ? [...remaining, ...staleEntries(violations, files, allowlist)]
    : remaining;
}
