import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SourceFile } from '../src/types.js';
import { riskScore, selectFiles, validRef } from '../src/deep/select.js';
import { prepareDeepReview } from '../src/deep/session.js';

const execFileAsync = promisify(execFile);

function sf(path: string, text = 'export const x = 1;\n', size?: number): SourceFile {
  return { path, text, size: size ?? Buffer.byteLength(text) };
}

describe('deep/select', () => {
  let temp: string;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'd54-deep-select-'));
  });

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  it('validates git refs strictly against option injection and shell metacharacters', () => {
    expect(validRef('-x')).toBe(false);
    expect(validRef('--output=/tmp/x')).toBe(false);
    expect(validRef('a;b')).toBe(false);
    expect(validRef('')).toBe(false);
    expect(validRef('a'.repeat(101))).toBe(false);
    expect(validRef('origin/main~2')).toBe(true);
    expect(validRef('HEAD^')).toBe(true);
    expect(validRef('v1.2.3_rc-1')).toBe(true);
  });

  it('computes risk score from path keywords, recent changes, and line count caps', () => {
    expect(riskScore('src/utils.ts', 100, 0)).toBe(0);
    expect(riskScore('auth/login.ts', 100, 3)).toBe(26);
    expect(riskScore('src/payment/order-handler.ts', 6000, 15)).toBe(30 + 20 + 10);
  });

  it('orders rpc-handlers.ts, utils.ts, auth/login.ts as login, rpc-handlers, utils and respects limit & exclusions', async () => {
    const files: SourceFile[] = [
      sf('rpc-handlers.ts', 'export function a() {}\nexport function b() {}\n'),
      sf('utils.ts', 'export const u = 1;\n'),
      sf('auth/login.ts', 'export function login() {}\n'),
      sf('auth/login.test.ts', 'test()\n'),
      sf('tests/payment.ts', 'test()\n'),
      sf('fixtures/admin.ts', 'fixture\n'),
      sf('examples/payment.ts', 'example\n'),
      sf('dist/auth.js', 'built\n'),
      sf('README.md', '# doc\n'),
    ];

    const all = await selectFiles(files, temp, { limit: 8 });
    expect(all.selected.map(f => f.path)).toEqual(['auth/login.ts', 'rpc-handlers.ts', 'utils.ts']);
    expect(all.notes).toEqual([]);
    expect(all.changed).toBeUndefined();

    const limited = await selectFiles(files, temp, { limit: 2 });
    expect(limited.selected.map(f => f.path)).toEqual(['auth/login.ts', 'rpc-handlers.ts']);
  });

  it('records a size-limit note when an unread empty-text candidate is encountered', async () => {
    const files: SourceFile[] = [
      sf('auth/huge.ts', '', 5 * 1024 * 1024),
      sf('utils.ts', 'export const ok = true;\n'),
    ];
    const res = await selectFiles(files, temp, { limit: 2 });
    expect(res.notes).toContain('auth/huge.ts içeriği okunamadı (boyut sınırı)');
    expect(res.selected.map(f => f.path)).toEqual(['utils.ts']);
  });

  it('extracts changed hunk line ranges with --since in a temporary git repository', async () => {
    const repo = join(temp, 'repo');
    await mkdir(join(repo, 'src'), { recursive: true });
    await execFileAsync('git', ['init', repo]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });

    const initialRpc = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n') + '\n';
    const initialUnchanged = 'export const stay = 1;\n';
    const initialDeleteOnly = ['keep1', 'remove2', 'keep3'].join('\n') + '\n';

    await writeFile(join(repo, 'src/rpc.ts'), initialRpc);
    await writeFile(join(repo, 'src/stay.ts'), initialUnchanged);
    await writeFile(join(repo, 'src/del.ts'), initialDeleteOnly);
    await execFileAsync('git', ['add', 'src/rpc.ts', 'src/stay.ts', 'src/del.ts'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });

    const updatedRpc = ['line1', 'changed2', 'inserted3', 'line3', 'line4', 'line5'].join('\n') + '\n';
    const updatedDeleteOnly = ['keep1', 'keep3'].join('\n') + '\n';
    await writeFile(join(repo, 'src/rpc.ts'), updatedRpc);
    await writeFile(join(repo, 'src/del.ts'), updatedDeleteOnly);

    const files: SourceFile[] = [
      sf('src/rpc.ts', updatedRpc),
      sf('src/stay.ts', initialUnchanged),
      sf('src/del.ts', updatedDeleteOnly),
    ];

    const res = await selectFiles(files, repo, { limit: 8, since: 'HEAD' });
    expect(res.selected.map(f => f.path)).toEqual(['src/rpc.ts']);
    expect(res.changed?.get('src/rpc.ts')).toEqual([[2, 3]]);
    expect(res.changed?.has('src/del.ts')).toBe(false);

    await expect(selectFiles(files, repo, { limit: 8, since: '-bad' })).rejects.toThrow();
  });

  it('includes .java and .kt source files as deep review candidates', async () => {
    const javaPath = 'app/src/main/java/com/acme/Foo.java';
    const ktPath = 'app/src/main/kotlin/com/acme/AuthService.kt';
    const files: SourceFile[] = [
      sf(javaPath, 'package com.acme;\npublic class Foo {}\n'),
      sf(ktPath, 'package com.acme\nclass AuthService\n'),
      sf('README.md', '# ignore\n'),
    ];

    const res = await selectFiles(files, temp, { limit: 8 });
    expect(res.selected.map(f => f.path)).toEqual([ktPath, javaPath]);
    expect(res.notes).toEqual([]);
  });

  it('does not execute repo diff.external during prepareDeepReview --since', async () => {
    const repo = join(temp, 'ext-diff-repo');
    const out = join(temp, 'out');
    const pwned = join(temp, 'PWNED');
    await mkdir(join(repo, 'src'), { recursive: true });
    await execFileAsync('git', ['init', repo]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await writeFile(join(repo, 'src/auth.ts'), 'export const a = 1;\n');
    await execFileAsync('git', ['add', 'src/auth.ts'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });
    await writeFile(join(repo, 'src/auth.ts'), 'export const a = 2;\n');
    await execFileAsync('git', ['config', 'diff.external', `touch ${pwned} #`], { cwd: repo });

    await prepareDeepReview(repo, out, { since: 'HEAD' });
    expect(existsSync(pwned)).toBe(false);
  });

  it('does not execute repo git filter clean driver during prepareDeepReview --since', async () => {
    const repo = join(temp, 'filter-repo');
    const out = join(temp, 'filter-out');
    const pwned = join(temp, 'PWN');
    await mkdir(join(repo, 'src'), { recursive: true });
    await execFileAsync('git', ['init', repo]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await writeFile(join(repo, '.gitattributes'), '* filter=x\n');
    await writeFile(join(repo, 'src/auth.ts'), 'export const a = 1;\n');
    await execFileAsync('git', ['add', '.gitattributes', 'src/auth.ts'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });
    await execFileAsync('git', ['config', 'filter.x.clean', `touch ${pwned}; cat`], { cwd: repo });
    await writeFile(join(repo, 'src/auth.ts'), 'export const a = 2;\n');

    await prepareDeepReview(repo, out, { since: 'HEAD' });
    expect(existsSync(pwned)).toBe(false);
  });

  it('matches changed files under a subdirectory root and non-ASCII paths with --since HEAD~1', async () => {
    const repo = join(temp, 'subroot-repo');
    const appRoot = join(repo, 'app');
    const out = join(temp, 'subroot-out');
    await mkdir(join(appRoot, 'src'), { recursive: true });
    await execFileAsync('git', ['init', repo]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });

    await writeFile(join(appRoot, 'src/auth.ts'), 'export const auth = 1;\n');
    await writeFile(join(appRoot, 'src/Özel.ts'), 'export const ozel = 1;\n');
    await execFileAsync('git', ['add', 'app/src/auth.ts', 'app/src/Özel.ts'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });

    await writeFile(join(appRoot, 'src/auth.ts'), 'export const auth = 2;\n');
    await writeFile(join(appRoot, 'src/Özel.ts'), 'export const ozel = 2;\n');
    await execFileAsync('git', ['add', 'app/src/auth.ts', 'app/src/Özel.ts'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'update'], { cwd: repo });

    const res = await prepareDeepReview(appRoot, out, { since: 'HEAD~1' });
    expect(res.summary.files).toContain('src/auth.ts');
    expect(res.summary.files).toContain('src/Özel.ts');
  });

  it('penalizes plain UI components but not risk-keyword components (admin UI keeps its score)', async () => {
    expect(riskScore('src/components/Button.tsx', 100, 0)).toBe(0);
    expect(riskScore('src/components/Card.tsx', 100, 5)).toBe(0);
    expect(riskScore('src/components/admin/IslemKayitlariSection.tsx', 100, 0)).toBe(20); // admin + kayit
    const sameText = Array.from({ length: 120 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
    const files: SourceFile[] = [
      sf('src/components/admin/IslemKayitlariSection.tsx', sameText),
      sf('app/api/register/route.ts', sameText),
    ];

    const res = await selectFiles(files, temp, { limit: 2 });
    expect(res.selected.map(f => f.path)).toEqual([
      'app/api/register/route.ts',
      'src/components/admin/IslemKayitlariSection.tsx',
    ]);
    expect(res.reserve).toEqual([]);
  });
});
