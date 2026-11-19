import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repositoryEnv, safeGitArgs } from '../git-state.js';
import { isTestPath } from '../scanners/static-utils.js';
import type { SourceFile } from '../types.js';

const execFileAsync = promisify(execFile);

export const RISK_KEYWORDS = [
  'auth', 'login', 'session', 'permission', 'role', 'admin',
  'payment', 'odeme', 'billing', 'wallet', 'cuzdan',
  'register', 'kayit', 'registration',
  'order', 'price', 'fiyat', 'refund', 'iade',
  'rpc', 'handler', 'route', 'api', 'webhook',
] as const;

const CANDIDATE_EXT = /\.(?:tsx?|jsx?|mjs|cjs|py|php|rs|java|kt)$/i;
const EXCLUDED_DIR = /(?:^|\/)(?:fixtures?|examples?|dist|build)(?:\/|$)/i;
const VALID_REF_RE = /^[A-Za-z0-9._/~^-]{1,100}$/;

export function validRef(ref: string): boolean {
  return !ref.startsWith('-') && VALID_REF_RE.test(ref);
}

export function isCandidatePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return CANDIDATE_EXT.test(normalized) && !isTestPath(normalized) && !EXCLUDED_DIR.test(normalized);
}

export function riskScore(path: string, lines: number, recentChanges: number): number {
  const lower = path.replace(/\\/g, '/').toLowerCase();
  let score = 0;
  for (const kw of RISK_KEYWORDS) {
    if (lower.includes(kw)) score += 10;
  }
  score += Math.min(20, Math.max(0, recentChanges) * 2);
  score += Math.min(10, Math.floor(Math.max(0, lines) / 500));
  return score;
}

function countLines(text: string): number {
  if (!text) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return text.endsWith('\n') ? count - 1 : count;
}

async function recentGitChanges(root: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        ...safeGitArgs,
        '-c', 'core.quotepath=false',
        'log',
        '--no-ext-diff', '--no-textconv', '--no-color', '--relative',
        '--since=90.days', '--name-only', '--format=', '--', '.',
      ],
      { cwd: root, maxBuffer: 16 * 1024 * 1024, timeout: 10_000, env: repositoryEnv() },
    );
    for (const raw of stdout.split(/\r?\n/)) {
      const p = raw.trim().replace(/\\/g, '/');
      if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  } catch {
    // Git yoksa veya depo değilse değişim 0 kabul edilir, not yazılmaz.
  }
  return counts;
}

function parseDiffPlusPath(line: string): string | undefined {
  const rest = line.slice(4).trim();
  if (rest === '/dev/null') return undefined;
  let cleaned = rest;
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = cleaned.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (cleaned.startsWith('b/')) cleaned = cleaned.slice(2);
  return cleaned.replace(/\\/g, '/');
}

async function diffRangesSince(root: string, ref: string): Promise<Map<string, Array<[number, number]>>> {
  if (!validRef(ref)) throw Error('Geçersiz --since git referansı.');
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      [
        ...safeGitArgs,
        '-c', 'core.quotepath=false',
        'diff',
        '--no-ext-diff', '--no-textconv', '--no-color', '--relative',
        '--src-prefix=a/', '--dst-prefix=b/',
        '--unified=0', '-M', ref, '--',
      ],
      { cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: 15_000, env: repositoryEnv() },
    ));
  } catch {
    throw Error('Git farkı alınamadı: referansı ve git deposunu kontrol edin.');
  }
  const changed = new Map<string, Array<[number, number]>>();
  let currentFile: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      currentFile = undefined;
    } else if (line.startsWith('+++ ')) {
      currentFile = parseDiffPlusPath(line);
    } else if (currentFile && line.startsWith('@@ ')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count <= 0) continue;
      const ranges = changed.get(currentFile) ?? [];
      ranges.push([start, start + count - 1]);
      changed.set(currentFile, ranges);
    }
  }
  return changed;
}

export async function selectFiles(
  files: readonly SourceFile[],
  root: string,
  o: { limit: number; since?: string },
): Promise<{ selected: SourceFile[]; changed?: Map<string, Array<[number, number]>>; notes: string[] }> {
  const changed = o.since !== undefined ? await diffRangesSince(root, o.since) : undefined;
  const recent = await recentGitChanges(root);
  const limit = Math.max(0, Math.min(20, o.limit));
  const notes: string[] = [];

  const candidates = files
    .map(file => ({ file, normPath: file.path.replace(/\\/g, '/') }))
    .filter(({ normPath }) => isCandidatePath(normPath) && (!changed || changed.has(normPath)))
    .map(({ file, normPath }) => ({
      file,
      normPath,
      score: riskScore(normPath, countLines(file.text), recent.get(normPath) ?? 0),
    }))
    .sort((a, b) => b.score - a.score || a.normPath.localeCompare(b.normPath, 'en'));

  const selected: SourceFile[] = [];
  for (const item of candidates) {
    if (selected.length >= limit) break;
    if (!item.file.text) {
      notes.push(`${item.file.path} içeriği okunamadı (boyut sınırı)`);
      continue;
    }
    selected.push(item.file);
  }

  return { selected, ...(changed ? { changed } : {}), notes };
}
