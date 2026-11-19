import { describe, expect, it } from 'vitest';
import type { SourceFile } from '../src/types.js';
import { chunkFile, deepSensitive, renderChunks, renderChunksWithStats } from '../src/deep/chunk.js';

function sf(path: string, text: string): SourceFile {
  return { path, text, size: Buffer.byteLength(text) };
}

describe('deep/chunk', () => {
  it('detects real secret patterns without masking auth identifiers', () => {
    expect(deepSensitive('const apiKey = "sk_live_12345";')).toBe(true);
    expect(deepSensitive('const dbPassword = "super-secret-value";')).toBe(true);
    expect(deepSensitive('const key = "AbCdEfGhIjKlMnOpQrStUvWxYz12";')).toBe(true);
    expect(deepSensitive('Authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"')).toBe(true);
    expect(deepSensitive('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);

    expect(deepSensitive('if (!isAuthorized(user)) return false;')).toBe(false);
    expect(deepSensitive('const authUser = getSessionUser(req);')).toBe(false);
    expect(deepSensitive('requireAuth(ctx);')).toBe(false);
  });

  it('extracts top-level functions, class methods, and object-literal arrows while keeping nested functions inside outer chunk', () => {
    const code = [
      'export function topHelper(x: number) {',
      '  function nestedInside(y: number) { return y + 1; }',
      '  return nestedInside(x);',
      '}',
      '',
      'export class OrderService {',
      '  charge(amount: number) {',
      '    return amount * 2;',
      '  }',
      '}',
      '',
      'export const handlers = {',
      '  createSession: async (uid: string) => {',
      '    return { uid };',
      '  },',
      '  ping() {',
      '    return "pong";',
      '  },',
      '} as const;',
    ].join('\n');

    const chunks = chunkFile(sf('src/service.ts', code));
    const names = chunks.map(c => c.name);
    expect(names).toContain('topHelper');
    expect(names).toContain('OrderService.charge');
    expect(names).toContain('handlers.createSession');
    expect(names).toContain('handlers.ping');
    expect(names.some(n => n.includes('nestedInside'))).toBe(false);
    // Risk keyword chunks (OrderService.charge, handlers.*) sort ahead of plain topHelper
    expect(names.indexOf('handlers.createSession')).toBeLessThan(names.indexOf('topHelper'));
  });

  it('splits a 700-line TS function into 3 overlapping 300-line windows (overlap 20)', () => {
    const body = Array.from({ length: 698 }, (_, i) => `  const v${i} = ${i};`);
    const code = ['export function bigProcess() {', ...body, '}'].join('\n');
    const chunks = chunkFile(sf('src/big.ts', code));
    expect(chunks).toHaveLength(3);
    expect(chunks.map(c => [c.start, c.end])).toEqual([
      [1, 300],
      [281, 580],
      [561, 700],
    ]);
  });

  it('filters chunks by changed line ranges and supports 200-line windows for non-TS files', () => {
    const tsCode = [
      'export function untouched() {',
      '  return 1;',
      '}',
      '',
      'export function modifiedFn() {',
      '  return 2;',
      '}',
    ].join('\n');
    const filtered = chunkFile(sf('src/mod.ts', tsCode), [[6, 6]]);
    expect(filtered.map(c => c.name)).toEqual(['modifiedFn']);

    const pyCode = Array.from({ length: 450 }, (_, i) => `x_${i} = ${i}`).join('\n');
    const pyChunks = chunkFile(sf('src/worker.py', pyCode));
    expect(pyChunks).toHaveLength(3);
    expect(pyChunks.map(c => [c.start, c.end]).sort((a, b) => a[0]! - b[0]!)).toEqual([
      [1, 200],
      [201, 400],
      [401, 450],
    ]);
  });

  it('masks secret lines preserving line numbers, skips >30% masked chunks, and enforces 12,000 char limit', () => {
    const code = [
      'export function checkAccess(user: any) {',
      '  const apiKey = "sk_live_secret_999";',
      '  if (!isAuthorized(user)) {',
      '    return false;',
      '  }',
      '  return Boolean(user);',
      '}',
      '',
      'export function mostlySecrets() {',
      '  const s1 = "sk_live_secret_111";',
      '  const s2 = "sk_live_secret_222";',
      '  return 1;',
      '}',
    ].join('\n');

    const file = sf('src/access.ts', code);
    const chunks = chunkFile(file);
    const { blocks, skippedMasked } = renderChunksWithStats(file, chunks, 12_000);
    expect(skippedMasked).toBe(1);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.masked).toEqual([2]);
    expect(blocks[0]!.text).toContain('### src/access.ts · checkAccess · 1-7');
    expect(blocks[0]!.text).toContain('2| <gizli satır>');
    expect(blocks[0]!.text).not.toContain('sk_live_secret');
    expect(blocks[0]!.text).toContain('3|   if (!isAuthorized(user)) {');

    // Enforce 12,000 char boundary across many chunks and long chunks
    const manyFns = Array.from({ length: 30 }, (_, idx) => {
      const lines = Array.from({ length: 20 }, (__, j) => `  const step_${idx}_${j} = "${'x'.repeat(20)}_${j}";`);
      return [`export function fn_${idx}() {`, ...lines, '}'].join('\n');
    }).join('\n\n');
    const largeFile = sf('src/many.ts', manyFns);
    const largeChunks = chunkFile(largeFile);
    const rendered = renderChunks(largeFile, largeChunks, 12_000);
    expect(rendered.length).toBeGreaterThan(1);
    for (const block of rendered) {
      expect(block.text.length).toBeLessThanOrEqual(12_000);
    }
  });

  it('splits .kt and .java files into 200-line windows using the non-TS path', () => {
    const ktCode = Array.from({ length: 450 }, (_, i) => `val item${i} = ${i}`).join('\n');
    const ktChunks = chunkFile(sf('app/src/main/kotlin/com/example/Main.kt', ktCode));
    expect(ktChunks).toHaveLength(3);
    expect(ktChunks.map(c => [c.start, c.end]).sort((a, b) => a[0]! - b[0]!)).toEqual([
      [1, 200],
      [201, 400],
      [401, 450],
    ]);
    expect(ktChunks.map(c => c.name).sort()).toEqual(['pencere-1', 'pencere-2', 'pencere-3']);

    const javaCode = Array.from({ length: 250 }, (_, i) => `int v${i} = ${i};`).join('\n');
    const javaChunks = chunkFile(sf('app/src/main/java/com/example/Foo.java', javaCode));
    expect(javaChunks).toHaveLength(2);
    expect(javaChunks.map(c => [c.start, c.end]).sort((a, b) => a[0]! - b[0]!)).toEqual([
      [1, 200],
      [201, 250],
    ]);
  });
});
