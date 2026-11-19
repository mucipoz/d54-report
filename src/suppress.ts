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
const IGNORE_FILENAME = '.d54report-ignore';

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let out = '^';
  for (let i = 0; i < normalized.length;) {
    if (normalized[i] === '*' && normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 3;
      } else {
        out += '.*';
        i += 2;
      }
    } else if (normalized[i] === '*') {
      out += '[^/]*';
      i += 1;
    } else {
      out += normalized[i]!.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(out + '$');
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
      rules.push({ rule, path: normalizePath(lineMatch[1]), line: parsedLine, reason });
    } else {
      rules.push({ rule, path: normalizePath(rawTarget), reason });
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

  const compiled = rules.map(rule => ({ rule, regex: globToRegExp(rule.path) }));
  const kept: Issue[] = [];
  let suppressed = 0;
  let suppressedKnownCredentials = 0;

  for (const issue of issues) {
    const file = issue.file ? normalizePath(issue.file) : undefined;
    const matched = file !== undefined && compiled.some(({ rule, regex }) =>
      (rule.rule === '*' || rule.rule === issue.rule)
      && (rule.line === undefined || rule.line === issue.line)
      && regex.test(file),
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
