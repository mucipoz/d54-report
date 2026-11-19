import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { scanSignals } from '../src/scanners/review-signals.js';
import { syntax } from '../src/scanners/syntax.js';
import type { SourceFile } from '../src/types.js';

const source = (path: string, text: string): SourceFile => ({ path, text, size: Buffer.byteLength(text) });

describe('source review signals', () => {
  it('distinguishes a repeating timer with no cleanup from an explicitly cleared timer', () => {
    const start = 'function start(tick) {\n  const id = setInterval(tick, 1000);\n';
    expect(scanSignals(source('clock.js', start + '}'))).toEqual([
      expect.objectContaining({ rule: 'performance.lifecycle-setInterval', file: 'clock.js', line: 2 }),
    ]);
    expect(scanSignals(source('clock.js', start + '  return () => clearInterval(id);\n}'))).toEqual([]);
  });

  it('reports access past the last element and accepts an exclusive array bound', () => {
    const loop = (condition: string) => 'function sum(values) {\n  let total = 0;\n  for (let i = 0; i ' +
      condition + ' values.length; i++) { total += values[i]; }\n  return total;\n}';
    expect(scanSignals(source('sum.js', loop('<=')))).toEqual([
      expect.objectContaining({ rule: 'bugs.index-bound', category: 'bugs', line: 3 }),
    ]);
    expect(scanSignals(source('sum.js', loop('<')))).toEqual([]);
  });

  it('reports private environment filenames without including any file contents', () => {
    const text = 'APP_VALUE=PRIVATE_FIXTURE_MARKER\n';
    const findings = scanSignals(source('service/.env.production', text));
    expect(findings).toEqual([expect.objectContaining({ file: 'service/.env.production', rule: 'security.env-file' })]);
    expect(JSON.stringify(findings)).not.toContain('PRIVATE_FIXTURE_MARKER');
    expect(JSON.stringify(findings)).not.toContain('APP_VALUE');
    for (const name of ['.env.example', '.env.sample', '.env.template']) expect(scanSignals(source(name, text))).toEqual([]);
  });
});

describe('source syntax', () => {
  it('locates invalid YAML and TOML while accepting valid documents in the same batch', () => {
    const result = syntax([
      source('broken.yml', 'name: first\nname: second\n'),
      source('broken.toml', '[app]\nport = [\n'),
      source('valid.yaml', 'app:\n  port: 4173\n---\ntitle: Saat\n'),
      source('valid.toml', '[app]\nname = "Saat"\nport = 4173\n'),
    ]);
    expect(result.notes).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({ category: 'errors', rule: 'errors.syntax-yaml', file: 'broken.yml', line: 2 }),
      expect.objectContaining({ category: 'errors', rule: 'errors.syntax-toml', file: 'broken.toml' }),
    ]);
    expect(result.issues[1]!.line).toBeGreaterThanOrEqual(1);
  });

  const hasPython = spawnSync('python3', ['-I', '-S', '--version']).status === 0;
  it.skipIf(!hasPython)('parses Python source without executing it and reports the failing line', () => {
    const result = syntax([
      source('valid.py', 'raise RuntimeError("Source must never be executed")\n'),
      source('bad.py', 'name = "test"\nif True\n    pass\n'),
    ]);
    expect(result.notes).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({ file: 'bad.py', line: 2, severity: 'high', rule: 'errors.syntax-python' }),
    ]);
  });

  it('records incomplete coverage when the optional Python interpreter is missing', () => {
    vi.stubEnv('PATH', '');
    try {
      const result = syntax([source('app.py', 'pass\n')]);
      expect(result.issues).toEqual([]);
      expect(result.notes.join(' ')).toContain('python3');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
