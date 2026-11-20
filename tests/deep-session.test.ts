import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSession, prepareDeepReview } from '../src/deep/session.js';

const execFileAsync = promisify(execFile);

describe('deep/session', () => {
  let temp: string;
  let project: string;
  let out: string;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'd54-deep-session-'));
    project = join(temp, 'proj');
    out = join(temp, 'reports');
    await mkdir(join(project, 'src/auth'), { recursive: true });
  });

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  it('creates chunk files and session.json with 0o600 permissions while masking secrets', async () => {
    const secretVal = 'sk_live_SUPER_SECRET_TOKEN_987654';
    const src = [
      'export async function loginHandler(user: { id: string; role: string }) {',
      `  const apiKey = "${secretVal}";`,
      '  if (!user.role) return null;',
      '  return { ok: true, id: user.id };',
      '}',
    ].join('\n') + '\n';
    await writeFile(join(project, 'src/auth/login.ts'), src);

    const res = await prepareDeepReview(project, out, {});
    expect(res.session).toMatch(/^[a-f0-9]{16}$/);
    expect(res.chunkFiles.length).toBeGreaterThanOrEqual(1);
    expect(res.summary.files).toEqual(['src/auth/login.ts']);
    expect(res.summary.chunks).toBe(1);
    expect(res.instructions).toContain('authz');
    expect(res.instructions).toContain('confirmed');
    expect(res.instructions).toContain('quote');

    for (const cf of res.chunkFiles) {
      const content = await readFile(cf, 'utf8');
      expect(content).not.toContain(secretVal);
      expect(content).toContain('2| <gizli satır>');
      expect(content).toContain('3|   if (!user.role) return null;');
      const info = await stat(cf);
      expect(info.mode & 0o777).toBe(0o600);
    }

    const session = await loadSession(out, res.session);
    expect(session.id).toBe(res.session);
    expect(session.files).toHaveLength(1);
    expect(session.files[0]!.path).toBe('src/auth/login.ts');
    expect(session.chunks[0]!.masked).toEqual([2]);
  });

  it('rejects path traversal, malformed session IDs, symlinks, and missing sessions', async () => {
    await mkdir(out, { recursive: true });
    await expect(loadSession(out, '../x')).rejects.toThrow();
    await expect(loadSession(out, '../../etc/passwd')).rejects.toThrow();
    await expect(loadSession(out, 'not-hex-16-chars!')).rejects.toThrow();
    await expect(loadSession(out, '0123456789abcdef')).rejects.toThrow();

    // Symlink escape attempt under a valid 16-hex session name
    const outside = join(temp, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(
      join(outside, 'session.json'),
      JSON.stringify({ id: 'abcdef0123456789', root: project, createdAt: new Date().toISOString(), files: [], chunks: [] }),
    );
    await mkdir(join(out, 'deep'), { recursive: true });
    await symlink(outside, join(out, 'deep', 'abcdef0123456789'));
    await expect(loadSession(out, 'abcdef0123456789')).rejects.toThrow();
  });

  it('handles a 1 MB+ rpc-handlers.ts with thousands of functions rapidly and respects maxChunks & 12k char limit', async () => {
    const fns: string[] = ['export const rpcHandlers = {'];
    for (let i = 0; i < 3000; i++) {
      const tag = i % 10 === 0 ? 'paymentOrder' : 'helperItem';
      fns.push(
        `  '${tag}_${i}': async (ctx: { userId?: string; amount: number }) => {`,
        `    const base = ctx.amount + ${i};`,
        `    if (base < 0) throw new Error('Geçersiz ödeme tutarı algılandı, işlem durduruldu: ' + ${i});`,
        `    const next = base * 2 + ${i};`,
        `    return { id: ctx.userId ?? 'anon', total: next, note: 'İşlem kaydı başarıyla oluşturuldu ve doğrulandı' };`,
        `  },`,
      );
    }
    fns.push('};');
    const bigText = fns.join('\n') + '\n';
    expect(Buffer.byteLength(bigText)).toBeGreaterThan(1_050_000);
    await writeFile(join(project, 'src/rpc-handlers.ts'), bigText);

    const t0 = Date.now();
    const res = await prepareDeepReview(project, out, { maxChunks: 25 });
    const elapsedMs = Date.now() - t0;

    expect(elapsedMs).toBeLessThan(5000);
    expect(res.summary.chunks).toBeLessThanOrEqual(25);
    expect(res.chunkFiles.length).toBeLessThanOrEqual(25);
    expect(res.summary.chunks).toBeGreaterThan(0);

    for (const cf of res.chunkFiles) {
      const text = await readFile(cf, 'utf8');
      expect(text.length).toBeLessThanOrEqual(12_000);
    }
  });

  it('includes .java and .kt files in prepareDeepReview selection', async () => {
    await writeFile(join(project, 'src/Svc.java'), 'public class Svc { public int run() { return 1; } }\n');
    await writeFile(join(project, 'src/Auth.kt'), 'class Auth { fun ok(): Boolean = true }\n');

    const res = await prepareDeepReview(project, out, {});
    expect(res.summary.files).toContain('src/Svc.java');
    expect(res.summary.files).toContain('src/Auth.kt');
  });

  it('adds untracked-files scope note in diff mode (--since) and omits it in full mode', async () => {
    await execFileAsync('git', ['init', project]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: project });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: project });
    await writeFile(join(project, 'src/a.ts'), 'export const a = 1;\n');
    await execFileAsync('git', ['add', 'src/a.ts'], { cwd: project });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: project });

    const note = 'İzlenmeyen yeni dosyalar fark modunda yok; önce git add -N kullanın.';
    const diffRes = await prepareDeepReview(project, out, { since: 'HEAD' });
    expect(diffRes.summary.notes).toContain(note);

    const fullRes = await prepareDeepReview(project, out, {});
    expect(fullRes.summary.notes).not.toContain(note);
  });

  it('caps chunks per file at perFileCap so one large file cannot monopolize maxChunks', async () => {
    const bigFns: string[] = [];
    for (let i = 0; i < 60; i++) {
      bigFns.push(
        `export function bigHandler_${i}(x: number) {`,
        `  const a = x + ${i};`,
        `  const b = a * 2;`,
        `  return b + ${i};`,
        `}`,
      );
    }
    await writeFile(join(project, 'src/auth/big-admin.ts'), bigFns.join('\n') + '\n');
    await writeFile(join(project, 'src/auth/small-1.ts'), 'export const s1 = 1;\n');
    await writeFile(join(project, 'src/auth/small-2.ts'), 'export const s2 = 2;\n');
    await writeFile(join(project, 'src/auth/small-3.ts'), 'export const s3 = 3;\n');
    for (let i = 0; i < 10; i++) {
      await writeFile(join(project, `src/reserve-${i}.ts`), `export const r${i} = ${i};\n`);
    }

    const res = await prepareDeepReview(project, out, { files: 4, maxChunks: 12 });
    const session = await loadSession(out, res.session);
    const bigChunks = session.chunks.filter(c => c.file === 'src/auth/big-admin.ts');
    const perFileCap = Math.max(Math.ceil(12 / 4), Math.ceil(12 / 4));
    expect(bigChunks.length).toBeLessThanOrEqual(perFileCap);
    expect(res.summary.files).toContain('src/auth/small-1.ts');
    expect(res.summary.files).toContain('src/auth/small-2.ts');
    expect(res.summary.files).toContain('src/auth/small-3.ts');
  });

  it('lifts the per-file cap when no reserve is left, uses the budget and notes truncation', async () => {
    const bigFns: string[] = [];
    for (let i = 0; i < 60; i++) {
      bigFns.push(`export function bigHandler_${i}(x: number) {`, `  return x + ${i};`, `}`);
    }
    await writeFile(join(project, 'src/auth/big-admin.ts'), bigFns.join('\n') + '\n');
    await writeFile(join(project, 'src/auth/small-1.ts'), 'export const s1 = 1;\n');

    const res = await prepareDeepReview(project, out, { files: 2, maxChunks: 12 });
    const session = await loadSession(out, res.session);
    expect(session.chunks.length).toBe(12);
    expect(session.chunks.filter(c => c.file === 'src/auth/big-admin.ts').length).toBe(11);
    expect(res.summary.notes).toContain('Parça sınırı (12) nedeniyle inceleme kapsamı sınırlandı.');
  });

  it('pulls reserve files when selected files are exhausted and records a balance note', async () => {
    await writeFile(join(project, 'src/auth/one.ts'), 'export const one = 1;\n');
    await writeFile(join(project, 'src/auth/two.ts'), 'export const two = 2;\n');
    await writeFile(join(project, 'src/three.ts'), 'export const three = 3;\n');

    const res = await prepareDeepReview(project, out, { files: 2, maxChunks: 12 });
    expect(res.summary.files).toHaveLength(3);
    expect(res.summary.files).toContain('src/three.ts');
    expect(res.summary.notes).toContain('1 dosya yedek listeden eklendi (parça bütçesi dengelendi).');
  });
});
