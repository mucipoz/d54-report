import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Finding, Issue, Report } from '../types.js';
import type { LLMProvider } from '../llm/provider.js';
import { candidateFile, deterministicFix, installLockForChecks, toolFix } from './deterministic-fixer.js';
import { llmFix } from './llm-fixer.js';
import { copyProject, declaredChecks, planStage, runChecks, runStage, sourcePath, verifyScan, type VerificationStep } from './verifier.js';
import { dirty, draftPullRequest, PublishUnavailable, repository, type AcceptedPatch } from './pr-manager.js';

export interface FixOptions {
  root: string; report: Report; out: string; mode: 'patch' | 'interactive' | 'pr';
  dryRun: boolean; force: boolean; yes: boolean; trusted?: boolean;
  ids?: string[]; severity?: string[]; provider?: LLMProvider; rescan: (dir: string) => Promise<Issue[]>;
}
export interface FixResult { id: string; status: string; detail?: string; patchPath?: string; verification?: VerificationStep[] }
const failed = 'FIX_FAILED (Rollback)';
const message = (err: unknown) => err instanceof Error ? err.message : 'Düzeltme başarısız';
const clean = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '');

function unified(work: string, file: string, before: string, after: string): string {
  const left = join(work, 'before'), right = join(work, 'after');
  writeFileSync(left, before);
  writeFileSync(right, after);
  const result = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--text', '--', left, right],
    { cwd: work, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15_000,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: dirname(work) } });
  const diff = result.stdout ?? '', hunk = diff.indexOf('\n@@ ');
  if (result.status !== 1 || hunk < 0) throw new Error('Birleşik diff üretilemedi');
  const header = (prefix: string) => file.includes(' ') ? JSON.stringify(prefix + file) : prefix + file;
  const a = header('a/'), b = header('b/');
  return `diff --git ${a} ${b}\n--- ${a}\n+++ ${b}` + diff.slice(hunk);
}

async function applyInCopy(tree: string, file: string, diff: string, expected: string, npmLock: boolean,
  preflight: VerificationStep, apply: VerificationStep) {
  const path = sourcePath(tree, file, npmLock);
  const execute = (flags: string[]) => {
    const result = spawnSync('git', ['apply', ...flags, '--whitespace=nowarn', '-'], { cwd: tree, input: diff,
      stdio: ['pipe', 'ignore', 'ignore'], timeout: 15_000,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: dirname(tree) } });
    if (result.status !== 0) throw new Error('Git yama bağlamını doğrulayamadı');
  };
  await runStage(preflight, 'Git yama bağlamını doğrulayamadı', () => execute(['--check']));
  await runStage(apply, 'Yama uygulanamadı veya sonuç beklenen kaynakla eşleşmedi', () => {
    execute([]);
    if (!readFileSync(path).equals(Buffer.from(expected))) throw new Error('Uygulanan yama beklenen kaynak ile eşleşmedi');
  });
}

function outputDirectory(dir: string) {
  const root = parse(dir).root;
  let current = root;
  for (const part of relative(root, dir).split(sep)) {
    if (!part || /^\.git$/i.test(part)) throw new Error('Geçersiz yama çıktı dizini');
    current = join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
    if (!lstatSync(current).isDirectory()) throw new Error('Çıktı yolunda güvenli olmayan bağlantı');
  }
}

function savePatch(out: string, id: string, diff: string): string {
  if (!/^[a-z\d][a-z\d_-]{0,80}$/i.test(id)) throw new Error('Geçersiz bulgu kimliği');
  const dir = join(out, 'patches');
  outputDirectory(dir);
  for (const suffix of ['', '-' + createHash('sha256').update(diff).digest('hex').slice(0, 16)]) {
    const path = join(dir, id + suffix + '.patch');
    try { writeFileSync(path, diff, { flag: 'wx', mode: 0o600 }); return path; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const entry = lstatSync(path);
      if (!entry.isFile()) throw new Error('Yama çıktı dosyası güvenli değil');
      if (entry.size === Buffer.byteLength(diff) && readFileSync(path, 'utf8') === diff) return path;
    }
  }
  throw new Error('Yama dosyası zaten var ve içeriği farklı');
}

function applySource(root: string, file: string, before: string, after: string, npmLock: boolean) {
  const path = sourcePath(root, file, npmLock), lock = path + '.d54-report.lock', temp = path + '.' + randomUUID();
  writeFileSync(lock, '', { flag: 'wx' });
  try {
    const mode = lstatSync(path).mode & 0o777;
    writeFileSync(temp, after, { flag: 'wx', mode: 0o600 });
    chmodSync(temp, mode);
    if (readFileSync(sourcePath(root, file, npmLock), 'utf8') !== before) throw new Error('Dosya doğrulamadan sonra değişti');
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); rmSync(lock, { force: true }); }
}

async function ask(prompt: string, detail: string): Promise<'e' | 'h' | 'q'> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return 'h';
  const interface_ = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const answer = (await interface_.question(prompt + ' [e/h/d/q] ')).trim().toLowerCase();
      if (answer === 'e' || answer === 'h' || answer === 'q') return answer;
      if (answer === 'd') process.stderr.write(clean(detail) + '\n');
    }
  } finally { interface_.close(); }
}

function preview(finding: Finding, diff: string): void {
  const tty = process.stderr.isTTY && !process.env.NO_COLOR;
  const color = (s: string, code: number) => tty ? '\x1b[' + code + 'm' + s + '\x1b[0m' : s;
  process.stderr.write(color(clean(`\n${finding.id} · ${finding.title} (${finding.severity})`), 1) + '\n' +
    clean(diff).split('\n').map(s => s.startsWith('+') ? color(s, 32) : s.startsWith('-') ? color(s, 31) : s).join('\n') + '\n');
}

export async function runFix(o: FixOptions): Promise<FixResult[]> {
  const root = realpathSync(resolve(o.root)), out = resolve(o.out);
  const selected = o.report.findings.filter(f => (!o.ids?.length || o.ids.includes(f.id)) &&
    (!o.severity?.length || o.severity.includes(f.severity)));
  if (!selected.length) return [];
  if (o.report.target.root && realpathSync(resolve(o.report.target.root)) !== root) throw new Error('Rapor başka bir proje dizinine ait');
  if (out === root) throw new Error('Raporlar için ayrı bir çıktı dizini seçin');
  if (repository(root) && !o.force && dirty(root, out)) {
    throw new Error('Git çalışma alanında değişiklik var. Devam etmek için --force kullanın.');
  }
  const temp = mkdtempSync(join(tmpdir(), 'd54-fix-')), base = join(temp, 'base');
  const results: FixResult[] = [], accepted: AcceptedPatch[] = [];
  try {
    copyProject(root, base, out, !!o.trusted);
    let baseline = await o.rescan(base);
    for (const finding of selected) {
      const work = mkdtempSync(join(temp, 'candidate-'));
      const verification: VerificationStep[] = [];
      const result: FixResult = { id: finding.id, status: 'SKIPPED', verification };
      results.push(result);
      try {
        const file = candidateFile(base, finding), npmLock = finding.rule === 'security.advisory-npm';
        if (!file || (npmLock && !o.trusted)) {
          result.detail = npmLock ? 'npm düzeltmesi için --trusted ve desteklenen kilit dosyası gerekli' : 'Kaynak dosya ve satır konumu gerekli';
          continue;
        }
        sourcePath(root, file, npmLock);
        const live = baseline.find(i => i.file === finding.file && i.rule === finding.rule && i.line === finding.line && i.title === finding.title && i.evidence === finding.evidence);
        if (!live) {
          result.detail = 'Güncel tarama bu konumdaki kanıtı doğrulamadı';
          continue;
        }
        const path = sourcePath(base, file, npmLock), before = readFileSync(path, 'utf8');
        let after = deterministicFix(before, live);
        if (after === undefined && o.trusted) after = toolFix(base, work, file, live);
        if (after === before) after = undefined;
        if (after === undefined && o.provider && !npmLock) after = await llmFix(o.provider, before, live);
        if (after === undefined || after === before) {
          result.detail = 'Bu bulgu için uygulanabilir yama yok';
          continue;
        }
        const preflight = planStage(verification, 'git apply --check'), apply = planStage(verification, 'git apply');
        const checks = declaredChecks(base, file, verification, !!o.trusted), verified = !checks.length || !!o.trusted;
        const rescan = planStage(verification, 'rescan');
        const diff = unified(work, file, before, after), tree = join(work, 'project');
        copyProject(base, tree, out, !!o.trusted);
        await applyInCopy(tree, file, diff, after, npmLock, preflight, apply);
        if (verified && checks.length) {
          const verify = join(work, 'checks'), home = join(work, 'home');
          mkdirSync(home);
          copyProject(base, verify, out, true);
          writeFileSync(sourcePath(verify, file, npmLock), after);
          if (npmLock) installLockForChecks(verify, file, home);
          await runChecks(verify, checks, home);
        }
        const scanned = await runStage(rescan, 'Yama sonrası tarama veya bulgu doğrulaması başarısız', async () => {
          const issues = await o.rescan(tree);
          verifyScan(baseline, issues, live);
          return issues;
        });
        if (o.dryRun || o.mode === 'interactive') preview(finding, diff);
        if (o.dryRun) {
          result.status = verified ? 'DRY_RUN' : 'DRY_RUN_UNVERIFIED';
          result.detail = verified ? 'Yama doğrulandı' : 'Proje komutları için --trusted gerekli';
          continue;
        }
        const patch = savePatch(out, finding.id, diff);
        result.patchPath = patch;
        if (!verified) {
          result.status = 'PATCH_UNVERIFIED';
          result.detail = patch + ' · proje komutları çalıştırılmadı';
          continue;
        }
        if (o.mode === 'interactive') {
          const answer = await ask('Bu yamayı uygula?', `${live.evidence}\n${live.impact}\n${live.advice}`);
          if (answer !== 'e') {
            result.detail = patch;
            if (answer === 'q') break;
            continue;
          }
          applySource(root, file, before, after, npmLock);
        }
        // Subsequent patches include earlier accepted changes, in report order.
        writeFileSync(path, after);
        baseline = scanned;
        accepted.push({ id: finding.id, file, before, after, diff, patch });
        result.status = o.mode === 'interactive' ? 'APPLIED' : 'PATCH_CREATED';
        result.detail = patch;
      } catch (err) {
        const detail = message(err);
        result.status = detail === 'Kaynak yolu düzeltme kapsamı dışında' ? 'SKIPPED' : failed;
        result.detail = detail;
      }
      finally { rmSync(work, { recursive: true, force: true }); }
    }
    if (o.mode === 'pr' && !o.dryRun && accepted.length) {
      const prSteps = new Map(results.filter(r => r.status === 'PATCH_CREATED').map(result =>
        [result.id, { log: result.verification!, verify: planStage(result.verification!, 'pr.verify') }] as const));
      try {
        if (!o.yes && await ask('Doğrulanan yamalar için taslak PR açılsın mı?', accepted.map(p => p.patch).join('\n')) !== 'e') {
          for (const result of results) if (result.status === 'PATCH_CREATED') {
            result.detail += ' · PR yayımlama onayı verilmedi';
            prSteps.get(result.id)!.verify.detail = 'PR yayımlama onayı verilmedi';
          }
          return results;
        }
        const url = await draftPullRequest(root, accepted, (project, change, checkBase, apply) => {
          const { log, verify: prStep } = prSteps.get(change.id)!;
          return runStage(prStep, 'PR tabanındaki doğrulama tamamlanamadı', async () => {
            const finding = selected.find(f => f.id === change.id)!;
            const baseScan = planStage(log, 'pr.baseline'), applyStep = planStage(log, 'pr.git apply --index');
            const work = mkdtempSync(join(temp, 'pr-check-')), cleanBase = join(work, 'before'), home = join(work, 'home');
            checkBase();
            mkdirSync(home);
            copyProject(project, cleanBase, '', false);
            const checks = declaredChecks(cleanBase, change.file, log, !!o.trusted, 'pr.');
            const rescan = planStage(log, 'pr.rescan');
            const dependencyDir = dirname(change.file);
            const install = (destination: string) => {
              if (!o.trusted) return;
              for (const dir of new Set(['.', dependencyDir])) {
                if (['package-lock.json', 'npm-shrinkwrap.json'].some(lock => existsSync(join(destination, dir, lock)))) {
                  installLockForChecks(destination, join(dir, 'package-lock.json'), home);
                }
              }
            };
            install(cleanBase);
            const before = await runStage(baseScan, 'PR tabanındaki hedef bulgu doğrulanamadı', async () => {
              const issues = await o.rescan(cleanBase);
              if (!issues.some(i => i.file === finding.file && i.rule === finding.rule && i.line === finding.line &&
                i.title === finding.title && i.evidence === finding.evidence)) throw new Error('PR tabanında hedef bulgu doğrulanamadı');
              return issues;
            });
            await runStage(applyStep, 'Git doğrulanan yamayı PR tabanına uygulayamadı', apply);
            const verify = join(work, 'after');
            copyProject(project, verify, '', false);
            install(verify);
            if (checks.length) {
              if (!o.trusted) throw new Error('PR tabanındaki kontroller için --trusted gerekli');
              const build = join(work, 'build');
              copyProject(verify, build, '', true);
              await runChecks(build, checks, home);
            }
            await runStage(rescan, 'PR yaması sonrası tarama veya bulgu doğrulaması başarısız', async () => {
              verifyScan(before, await o.rescan(verify), finding);
            });
          });
        });
        for (const result of results) if (result.status === 'PATCH_CREATED') { result.status = 'PR_CREATED'; result.detail += ' · ' + url; }
      } catch (err) {
        for (const result of results) if (result.status === 'PATCH_CREATED') {
          result.status = err instanceof PublishUnavailable ? 'PR_FALLBACK' : failed;
          result.detail += ' · ' + message(err);
        }
      }
    }
    return results;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
