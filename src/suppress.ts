import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readBoundedFile } from './fs-guards.js';
import { knownCredentialEvidence } from './scanners/security.js';
import type { Issue } from './types.js';

export type Suppression = {
  rule: string;
  path: string;
  line?: number;
  reason: string;
};

const MAX_IGNORE_BYTES = 256 * 1024;
const MAX_PATTERN_LENGTH = 256;
const IGNORE_FILENAME = '.d54report-ignore';

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function matchSegment(pat: string, str: string): boolean {
  let pi = 0;
  let si = 0;
  let starIdx = -1;
  let matchIdx = 0;

  while (si < str.length) {
    if (pi < pat.length && pat[pi] === str[si]) {
      pi++;
      si++;
    } else if (pi < pat.length && pat[pi] === '*') {
      starIdx = pi;
      matchIdx = si;
      pi++;
    } else if (starIdx !== -1) {
      pi = starIdx + 1;
      matchIdx++;
      si = matchIdx;
    } else {
      return false;
    }
  }

  while (pi < pat.length && pat[pi] === '*') {
    pi++;
  }

  return pi === pat.length;
}

function matchGlob(pattern: string, filePath: string): boolean {
  const patSegs = normalizePath(pattern).split('/');
  const pathSegs = normalizePath(filePath).split('/');

  let pi = 0;
  let si = 0;
  let starIdx = -1;
  let matchIdx = 0;

  while (si < pathSegs.length) {
    if (pi < patSegs.length && patSegs[pi] === '**') {
      starIdx = pi;
      matchIdx = si;
      pi++;
    } else if (pi < patSegs.length && matchSegment(patSegs[pi]!, pathSegs[si]!)) {
      pi++;
      si++;
    } else if (starIdx !== -1) {
      pi = starIdx + 1;
      matchIdx++;
      si = matchIdx;
    } else {
      return false;
    }
  }

  while (pi < patSegs.length && patSegs[pi] === '**') {
    pi++;
  }

  return pi === patSegs.length;
}

export async function loadSuppressions(root: string): Promise<{ rules: Suppression[]; notes: string[] }> {
  const ignorePath = resolve(root, IGNORE_FILENAME);
  const info = await lstat(ignorePath).catch(() => undefined);
  if (!info || !info.isFile()) return { rules: [], notes: [] };
  if (info.size > MAX_IGNORE_BYTES) {
    return { rules: [], notes: [`${IGNORE_FILENAME} 256 KiB sınırını aştığı için yok sayıldı.`] };
  }
  let raw: string;
  try {
    raw = (await readBoundedFile(ignorePath, MAX_IGNORE_BYTES)).toString('utf8');
  } catch {
    return { rules: [], notes: [] };
  }

  const rules: Suppression[] = [];
  const notes: string[] = [];
  const lines = raw.split(/\r?\n/);

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1;
    const trimmed = lines[idx]!.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const hashIndex = trimmed.indexOf('#');
    if (hashIndex === -1) {
      notes.push(`${IGNORE_FILENAME}:${lineNum} gerekçe yok, yok sayıldı`);
      continue;
    }
    const reason = trimmed.slice(hashIndex + 1).trim();
    if (!reason) {
      notes.push(`${IGNORE_FILENAME}:${lineNum} gerekçe yok, yok sayıldı`);
      continue;
    }

    const spec = trimmed.slice(0, hashIndex).trim();
    const parts = spec.split(/\s+/);
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      notes.push(`${IGNORE_FILENAME}:${lineNum} geçersiz biçim, yok sayıldı`);
      continue;
    }

    const [rule, rawTarget] = parts;
    const lineMatch = /^(.*):(\d+)$/.exec(rawTarget);
    if (lineMatch) {
      const parsedLine = Number(lineMatch[2]);
      if (!Number.isInteger(parsedLine) || parsedLine <= 0 || !lineMatch[1]) {
        notes.push(`${IGNORE_FILENAME}:${lineNum} geçersiz satır numarası, yok sayıldı`);
        continue;
      }
      const path = normalizePath(lineMatch[1]);
      if (path.length > MAX_PATTERN_LENGTH) {
        notes.push(`${IGNORE_FILENAME}:${lineNum} desen çok uzun, yok sayıldı`);
        continue;
      }
      rules.push({ rule, path, line: parsedLine, reason });
    } else {
      const path = normalizePath(rawTarget);
      if (path.length > MAX_PATTERN_LENGTH) {
        notes.push(`${IGNORE_FILENAME}:${lineNum} desen çok uzun, yok sayıldı`);
        continue;
      }
      rules.push({ rule, path, reason });
    }
  }

  return { rules, notes };
}

export function applySuppressions(
  issues: Issue[],
  rules: Suppression[],
): { kept: Issue[]; suppressed: number; suppressedKnownCredentials: number } {
  if (!rules.length) {
    return { kept: issues, suppressed: 0, suppressedKnownCredentials: 0 };
  }

  const kept: Issue[] = [];
  let suppressed = 0;
  let suppressedKnownCredentials = 0;

  for (const issue of issues) {
    const file = issue.file ? normalizePath(issue.file) : undefined;
    const matched = file !== undefined && rules.some(rule =>
      rule.path.length <= MAX_PATTERN_LENGTH
      && (rule.rule === '*' || rule.rule === issue.rule)
      && (rule.line === undefined || rule.line === issue.line)
      && matchGlob(rule.path, file),
    );
    if (matched) {
      suppressed++;
      if (issue.rule === 'security.literal-secret' && issue.evidence === knownCredentialEvidence) {
        suppressedKnownCredentials++;
      }
    } else {
      kept.push(issue);
    }
  }

  return { kept, suppressed, suppressedKnownCredentials };
}
