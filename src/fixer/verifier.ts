import { spawnSync } from 'node:child_process';
import { constants, cpSync, existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { Issue } from '../types.js';

export function sourcePath(root: string, file: string, lock = false): string {
  const parts = file.split('/');
  const npmLock = lock && /^(?:package-lock|npm-shrinkwrap)\.json$/.test(basename(file));
  if (!file || isAbsolute(file) || parts.some(p => !p || p.startsWith('.') || p.startsWith('-')) ||
      /[\\:"\x00-\x1f\x7f]/.test(file) || /(?:^|\/)(?:node_modules|vendor|dist|build|coverage|ci|scripts|hooks|tests?|__tests__|__mocks__)(?:\/|$)/i.test(file) ||
      (!npmLock && /(?:^|[./_-])(?:config|lock|spec|test|secret|secrets|credentials|private[-_]?key)(?:[./_-]|$)/i.test(file)) ||
      (!npmLock && !/\.(?:[cm]?[jt]sx?|astro|html?|vue|svelte|css|scss|py|go|rs|java|kt|dart|php|rb)$/i.test(file)) ||
      /^(?:setup|conftest|build|manage|vite-env|next-env|jest\.setup)\./i.test(basename(file))) {
    throw new Error('Kaynak yolu düzeltme kapsamı dışında');
  }
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink()) throw new Error('Sembolik bağlantı izlenmedi');
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Dosya türü veya boyutu desteklenmiyor');
  return path;
}

export function copyProject(from: string, to: string, out: string, dependencies: boolean): void {
  const ignored = new Set(['.git', '.hg', '.svn', 'dist', 'build', 'coverage', '.next', '.venv', 'target']);
  cpSync(from, to, {
    recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
    filter(path) {
      if (path === from) return true;
      if (path === out || ignored.has(basename(path)) || (!dependencies && basename(path) === 'node_modules')) return false;
      const stat = lstatSync(path);
      if (!stat.isSymbolicLink()) return stat.isFile() || stat.isDirectory();
      if (!dependencies || !relative(from, path).split(sep).includes('node_modules') || isAbsolute(readlinkSync(path))) return false;
      const dest = relative(from, realpathSync(path));
      return dest !== '..' && !dest.startsWith('..' + sep) && !isAbsolute(dest);
    }
  });
}

type Check = { label: string; command: string; args: string[]; dir?: string };
export interface VerificationStep {
  stage: string;
  status: 'passed' | 'failed' | 'skipped';
  detail?: string;
}

export function planStage(log: VerificationStep[], stage: string, detail = 'Bu adıma ulaşılmadı'): VerificationStep {
  const step: VerificationStep = { stage, status: 'skipped', detail };
  log.push(step);
  return step;
}

export async function runStage<T>(step: VerificationStep, errorDetail: string, operation: () => T | Promise<T>): Promise<T> {
  try {
    const result = await operation();
    step.status = 'passed';
    delete step.detail;
    return result;
  } catch (error) {
    step.status = 'failed';
    step.detail = errorDetail;
    throw error;
  }
}

function localChecks(root: string): Check[] {
  const checks: Check[] = [];
  if (existsSync(join(root, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    for (const alternatives of [['build'], ['typecheck', 'type-check', 'check:types'], ['test']]) {
      const script = alternatives.find(name => typeof pkg.scripts?.[name] === 'string');
      if (script) checks.push({ label: script, command: 'npm', args: ['run', script] });
      else if (alternatives.includes('typecheck') && existsSync(join(root, 'tsconfig.json'))) {
        checks.push({ label: 'tsc --noEmit', command: process.execPath, args: [join('node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'] });
      }
    }
  }
  if (existsSync(join(root, 'go.mod'))) for (const cmd of ['build', 'test']) {
    checks.push({ label: 'go ' + cmd, command: 'go', args: [cmd, './...'] });
  }
  if (existsSync(join(root, 'Cargo.toml'))) for (const cmd of ['build', 'check', 'test']) {
    checks.push({ label: 'cargo ' + cmd, command: 'cargo', args: [cmd, '--offline'] });
  }
  if (['pytest.ini', 'conftest.py'].some(file => existsSync(join(root, file))) ||
      (existsSync(join(root, 'pyproject.toml')) && existsSync(join(root, 'tests')))) {
    checks.push({ label: 'pytest', command: 'python3', args: ['-m', 'pytest', '-q'] });
  }
  return checks;
}

export function declaredChecks(root: string, file: string, log: VerificationStep[], trusted: boolean, prefix = '') {
  const dirs = ['.'];
  for (let dir = dirname(file); dir !== '.'; dir = dirname(dir)) dirs.push(dir);
  return dirs.flatMap(dir => localChecks(join(root, dir)).map(check => ({
    ...check, dir, step: planStage(log, prefix + check.label, trusted ? undefined : '--trusted izni verilmedi')
  })));
}

export async function runChecks(root: string, checks: ReturnType<typeof declaredChecks>, home: string): Promise<void> {
  for (const check of checks) {
    await runStage(check.step, 'Proje kontrolü tamamlanamadı', () => {
      const result = spawnSync(check.command, check.args, { cwd: join(root, check.dir), timeout: 120_000, stdio: 'ignore',
        env: { HOME: home, PATH: process.env.PATH, CI: '1', npm_config_offline: 'true', GOTOOLCHAIN: 'local', GOPROXY: 'off' } });
      if (result.status !== 0) throw new Error(`Doğrulama başarısız: ${check.label}`);
    });
  }
}

const signature = (i: Issue) => JSON.stringify([i.rule, i.file, i.url, i.selector, i.viewport, i.severity, i.title, i.evidence]);
export function verifyScan(before: Issue[], after: Issue[], target: Issue): void {
  const count = (items: Issue[]) => items.filter(i => i.rule === target.rule && i.file === target.file).length;
  if (count(after) >= count(before)) throw new Error('Yeniden taramada hedef bulgu giderilmedi');
  const known = new Map<string, number>();
  for (const issue of before) known.set(signature(issue), (known.get(signature(issue)) ?? 0) + 1);
  for (const issue of after) {
    const key = signature(issue);
    const remaining = known.get(key) ?? 0;
    if (!remaining) throw new Error(`Yeni bulgu: ${issue.rule}`);
    known.set(key, remaining - 1);
  }
  const occurrences = (issues: Issue[]) => issues.filter(i => signature(i) === signature(target)).length;
  if (occurrences(after) >= occurrences(before)) throw new Error('Hedef kanıt yeniden taramada hâlâ mevcut');
}
