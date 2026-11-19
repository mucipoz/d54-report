import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runScan } from '../src/engine.js';
import { markdown } from '../src/reporters/markdown.js';
import { readReport } from '../src/reporters/read.js';
import { knownCredentialEvidence } from '../src/scanners/security.js';
import { applySuppressions, loadSuppressions } from '../src/suppress.js';
import type { Issue, Report } from '../src/types.js';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    rule: 'security.target-blank',
    category: 'security',
    severity: 'medium',
    title: 'Güvensiz dış bağlantı',
    file: 'src/index.html',
    line: 4,
    evidence: 'target="_blank"',
    impact: 'opener',
    advice: 'rel="noopener"',
    ...overrides,
  };
}

describe('suppress', () => {
  let temp: string;
  let root: string;
  let out: string;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'd54-suppress-'));
    root = join(temp, 'app');
    out = join(temp, 'out');
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
    await mkdir(out, { recursive: true });
  });

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  it('suppresses matching rule and path', () => {
    const issues = [
      makeIssue({ rule: 'security.target-blank', file: 'src/nested/page.html', line: 10 }),
      makeIssue({ rule: 'security.target-blank', file: 'other/page.html', line: 10 }),
      makeIssue({ rule: 'errors.empty-catch', category: 'errors', file: 'src/app.ts', line: 2 }),
    ];
    const result = applySuppressions(issues, [
      { rule: 'security.target-blank', path: 'src/**/*.html', reason: 'dahili sayfa' },
      { rule: '*', path: 'src/*.ts', reason: 'bilinçli' },
    ]);
    expect(result.suppressed).toBe(2);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]?.file).toBe('other/page.html');
  });

  it('line specific suppression', () => {
    const issues = [
      makeIssue({ file: 'index.html', line: 3 }),
      makeIssue({ file: 'index.html', line: 8 }),
    ];
    const result = applySuppressions(issues, [
      { rule: 'security.target-blank', path: 'index.html', line: 3, reason: 'onaylı' },
    ]);
    expect(result.suppressed).toBe(1);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]?.line).toBe(8);
  });

  it('invalid ignore line is reported not fatal', async () => {
    await writeFile(join(root, '.d54report-ignore'), [
      '# yorum satırı',
      '',
      'security.target-blank index.html #',
      'security.target-blank index.html:4 # geçerli gerekçe',
    ].join('\n'));
    const loaded = await loadSuppressions(root);
    expect(loaded.rules).toEqual([
      { rule: 'security.target-blank', path: 'index.html', line: 4, reason: 'geçerli gerekçe' },
    ]);
    expect(loaded.notes).toContain('.d54report-ignore:3 gerekçe yok, yok sayıldı');
  });

  it('ignores missing file without error and warns on oversized file', async () => {
    const missing = await loadSuppressions(root);
    expect(missing).toEqual({ rules: [], notes: [] });

    await writeFile(join(root, '.d54report-ignore'), 'a'.repeat(256 * 1024 + 1));
    const oversized = await loadSuppressions(root);
    expect(oversized.rules).toEqual([]);
    expect(oversized.notes.length).toBeGreaterThan(0);
  });

  it('suppressed excluded from health and omits suppressed field when none suppressed', async () => {
    await writeFile(join(root, 'index.html'), '<a target="_blank" href="https://example.com">Dış</a>\n');
    const baseline = await runScan({ path: root, out, browser: false, modules: ['security'] });
    expect('suppressed' in baseline.report).toBe(false);
    expect(baseline.report.schemaVersion).toBe(1);

    await writeFile(join(root, '.d54report-ignore'), 'security.target-blank index.html:1 # güvenli yönlendirme\n');
    const suppressedRun = await runScan({ path: root, out, browser: false, modules: ['security'] });
    expect(suppressedRun.report.suppressed).toBe(1);
    expect(suppressedRun.report.summary.total).toBe(0);
    expect(suppressedRun.report.summary.health).toBe(100);
    expect(suppressedRun.report.schemaVersion).toBe(1);

    const parsed = await readReport(suppressedRun.prefix + '.json');
    expect(parsed.suppressed).toBe(1);
    const md = await readFile(suppressedRun.prefix + '.md', 'utf8');
    expect(md).toContain('Bastırılan · 1');
  });

  it('counts suppressed knownCredential literal-secret separately in markdown', async () => {
    const awsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    await writeFile(join(root, 'src', 'keys.ts'), `export const k = "${awsKey}";\n`);
    await writeFile(join(root, '.d54report-ignore'), 'security.literal-secret src/keys.ts:1 # test anahtarı\n');

    const res = await runScan({ path: root, out, browser: false, modules: ['security'] });
    expect(res.report.suppressed).toBe(1);
    expect(res.report.suppressedKnownCredentials).toBe(1);

    const md = markdown(res.report as Report);
    expect(md).toContain('Bastırılan · 1');
    expect(md).toContain('Bastırılan gerçek biçimli anahtar · 1');
    expect(knownCredentialEvidence).toBe('Bilinen bir anahtar biçimi bulundu (AWS/GitHub/Slack/özel anahtar). Değer gizlendi.');
  });
});
