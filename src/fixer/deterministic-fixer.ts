import type { Issue } from '../types.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { copyProject, sourcePath } from './verifier.js';

/** Only change an unambiguous, literal anchor on the reported source line. */
export function deterministicFix(source: string, issue: Issue): string | undefined {
  if (issue.rule !== 'security.target-blank' || !issue.line) return;
  const anchors = [...source.matchAll(/<a\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi)].filter(match => {
    const first = source.slice(0, match.index).split('\n').length;
    const last = first + match[0].split('\n').length - 1;
    return first <= issue.line! && issue.line! <= last;
  });
  if (anchors.length !== 1) return;
  const match = anchors[0]!;
  const tag = match[0];
  // Tokenize attributes so text inside a quoted value cannot be mistaken for an attribute.
  const attrs = [...tag.slice(2, -1).matchAll(/\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)];
  const targets = attrs.filter(a => a[1]!.toLowerCase() === 'target');
  if (targets.length !== 1 || !targets.some(a => (a[2] ?? a[3] ?? a[4])?.toLowerCase() === '_blank')) return;
  const rel = attrs.filter(a => a[1]!.toLowerCase() === 'rel');
  let fixed: string;
  if (!rel.length) {
    fixed = tag.replace(/(\s*\/?>)$/, ' rel="noopener noreferrer"$1');
  } else {
    if (rel.length !== 1) return;
    const attr = rel[0]!;
    const value = attr[2] ?? attr[3];
    if (value === undefined || /[{}<>]/.test(value)) return;
    const tokens = value.trim().split(/\s+/).filter(Boolean);
    const missing = ['noopener', 'noreferrer'].filter(token => !tokens.some(existing => existing.toLowerCase() === token));
    if (!missing.length) return;
    const start = 2 + attr.index! + attr[0].length - value.length - 1;
    fixed = tag.slice(0, start) + [...tokens, ...missing].join(' ') + tag.slice(start + value.length);
  }
  return source.slice(0, match.index) + fixed + source.slice(match.index! + tag.length);
}

export function candidateFile(base: string, finding: Issue): string | undefined {
  if (!finding.file) return;
  if (finding.rule !== 'security.advisory-npm') return finding.line ? finding.file : undefined;
  if (basename(finding.file) !== 'package.json') return;
  const dir = dirname(finding.file);
  for (const lock of ['npm-shrinkwrap.json', 'package-lock.json']) {
    const file = dir === '.' ? lock : dir + '/' + lock;
    if (existsSync(join(base, file))) return file;
  }
}

function npmTask(dir: string, home: string, args: string[]) {
  return spawnSync('npm', [...args, '--ignore-scripts', '--fetch-retries=0', '--fetch-timeout=15000',
    '--registry=https://registry.npmjs.org', '--userconfig=/dev/null', '--globalconfig=/dev/null'], {
    cwd: dir, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: home, CI: '1', npm_config_fund: 'false' }
  });
}

function npmFix(base: string, work: string, file: string, issue: Issue): string | undefined {
  const dir = join(work, 'npm'), home = join(work, 'npm-home');
  mkdirSync(dir); mkdirSync(home);
  const lock = readFileSync(sourcePath(base, file, true), 'utf8');
  const manifest = readFileSync(join(base, dirname(file), 'package.json'), 'utf8');
  const pkg = JSON.parse(manifest);
  if (pkg.workspaces || /(?:git\+|git:|git@|github:|file:|link:|workspace:|https?:\/\/(?!registry\.npmjs\.org\/))/i.test(
    JSON.stringify([pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies, pkg.overrides]))) return;
  const known = JSON.parse(lock);
  if (!known.packages || Object.values(known.packages).some(entry => {
    const p = entry as { resolved?: string; link?: boolean };
    return p.link || (p.resolved && !/^https:\/\/registry\.npmjs\.org\//.test(p.resolved));
  })) return;
  writeFileSync(join(dir, 'package.json'), manifest);
  writeFileSync(join(dir, basename(file)), lock);
  const before = npmAdvisories(dir, home);
  const requested = issue.severity + '/' + (issue.title.match(/\b(?:CVE-[\d-]+|GHSA-[a-z0-9-]+)\b/i)?.[0] ?? '');
  if (!before.includes(requested)) throw new Error('Beklenen npm danışmanlık kaydı doğrulanamadı');
  const fix = npmTask(dir, home, ['audit', 'fix', '--package-lock-only', '--json']);
  if ((fix.status !== 0 && fix.status !== 1) || readFileSync(join(dir, 'package.json'), 'utf8') !== manifest) {
    throw new Error('npm audit fix kapsamlı olmayan bir kilit dosyası yaması üretemedi');
  }
  const next = readFileSync(join(dir, basename(file)), 'utf8'), parsed = JSON.parse(next);
  if (next === lock) return;
  if (JSON.stringify(known.packages['']) !== JSON.stringify(parsed.packages?.[''])) throw new Error('Kök bağımlılık sözleşmesi değişti');
  const remaining = npmAdvisories(dir, home);
  if (remaining.includes(requested)) throw new Error('Hedef npm danışmanlık kaydı devam ediyor');
  for (const item of remaining) {
    const index = before.indexOf(item);
    if (index < 0) throw new Error('Yeni npm danışmanlık kaydı oluştu');
    before.splice(index, 1);
  }
  return next;
}

function npmAdvisories(dir: string, home: string): string[] {
  const audit = npmTask(dir, home, ['audit', '--json', '--package-lock-only']);
  let data;
  try { data = JSON.parse(audit.stdout); } catch { throw new Error('npm advisory yeniden taraması okunamadı'); }
  if ((audit.status !== 0 && audit.status !== 1) || !data.vulnerabilities || data.error) throw new Error('npm advisory yeniden taraması doğrulanamadı');
  const rows: string[] = [];
  for (const entry of Object.values(data.vulnerabilities) as { via: unknown[]; severity: string }[]) {
    if (!Array.isArray(entry.via)) throw new Error('npm danışmanlık verisi geçersiz');
    const direct = entry.via.filter((v): v is {url?: string; severity: string} => !!v && typeof v === 'object');
    for (const v of direct) {
      const severity = ['critical', 'high', 'low'].includes(v.severity) ? v.severity : 'medium';
      rows.push(severity + '/' + (String(v.url ?? '').match(/\b(?:CVE-[\d-]+|GHSA-[a-z0-9-]+)\b/i)?.[0] ?? ''));
    }
    if (!direct.length && entry.via.length) rows.push((['critical', 'high', 'low'].includes(entry.severity) ? entry.severity : 'medium') + '/');
  }
  return rows;
}

export function installLockForChecks(project: string, file: string, home: string): void {
  if (npmTask(join(project, dirname(file)), home, ['ci', '--no-audit']).status !== 0) throw new Error('Güncel kilit dosyasının bağımlılıkları kurulamadı');
}

export function toolFix(base: string, work: string, file: string, issue: Issue): string | undefined {
  if (issue.rule === 'security.advisory-npm') return npmFix(base, work, file, issue);
  const eslint = join('node_modules', 'eslint', 'bin', 'eslint.js');
  const js = /\.[cm]?[jt]sx?$/.test(file) && existsSync(join(base, eslint));
  const rust = /\.rs$/.test(file) && /^cargo (?:clippy|check|build)\b/i.test(issue.title) && existsSync(join(base, 'Cargo.toml'));
  if (!js && !rust) return;
  const copy = join(work, 'tool'), home = join(work, 'tool-home');
  mkdirSync(home);
  copyProject(base, copy, '', true);
  const target = sourcePath(copy, file);
  const env = { HOME: home, PATH: process.env.PATH, CI: '1' };
  if (js) {
    const command = spawnSync(process.execPath, [eslint, '--fix-dry-run', '--format', 'json', '--', file],
      { cwd: copy, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    if (command.status !== 0 && command.status !== 1) return;
    const rows: unknown = JSON.parse(command.stdout);
    if (Array.isArray(rows) && rows.length === 1 && resolve(String(rows[0]?.filePath)) === target &&
        typeof rows[0]?.output === 'string') return rows[0].output;
  } else {
    const result = spawnSync('cargo', ['fix', '--allow-no-vcs', '--locked', '--offline'],
      { cwd: copy, env, stdio: 'ignore', timeout: 90_000 });
    if (result.status === 0) return readFileSync(sourcePath(copy, file), 'utf8');
  }
}
