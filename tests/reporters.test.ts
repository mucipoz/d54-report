import { describe, expect, it } from 'vitest';
import { json, makeReport } from '../src/reporters/json.js';
import { markdown } from '../src/reporters/markdown.js';
import type { Issue } from '../src/types.js';

const target = { project: 'örnek', root: '/example' };
const date = '2026-01-02T03:04:05.000Z';
const issue = (changes: Partial<Issue> = {}): Issue => ({
  rule: 'errors.sample', category: 'errors', severity: 'low',
  title: 'Örnek bulgu', evidence: 'Ölçüm', impact: 'Etki', advice: 'Düzeltin.',
  file: 'app.ts', line: 1, ...changes,
});

describe('report contract', () => {
  it('deduplicates, sorts and assigns stable category IDs across input orders', () => {
    const findings = [
      issue({ line: 11 }), issue({ line: 2 }), issue({ line: 2 }),
      issue({ category: 'security', severity: 'critical' }),
      issue({ category: 'performance', severity: 'medium' }),
      issue({ category: 'bugs', severity: 'high' }),
      issue({ category: 'specialized', severity: 'low' }),
    ];
    const build = (items: Issue[]) => makeReport(target, ['TypeScript'], 2, items, ['statik', 'statik'], date);
    const report = build(findings);
    expect(JSON.parse(json(report))).toEqual(report);
    expect(report).toEqual(build([...findings].reverse()));
    expect(report).toMatchObject({
      schemaVersion: 1, target, createdAt: date, stack: ['TypeScript'], filesScanned: 2,
      coverage: ['statik'],
      summary: { total: 6, counts: { critical: 1, high: 1, medium: 1, low: 3 }, health: 72 },
    });
    expect(report.findings.map(f => f.id)).toEqual(['SEC-001', 'BUG-001', 'PERF-001', 'ERR-001', 'ERR-002', 'SPEC-001']);
    expect(report.findings.filter(f => f.category === 'errors').map(f => f.line)).toEqual([2, 11]);
    expect(report.priority).toEqual(report.findings.slice(0, 5).map(f => f.id));
    const actions = markdown(report).split('## Öncelikli aksiyon planı')[1];
    expect(actions.match(/^\d+\. /gm)).toHaveLength(5);
    for (const [i, id] of report.priority.entries()) expect(actions).toContain((i + 1) + '. **' + id + '**');
  });

  it('preserves distinct viewport findings and links only portable screenshot paths', () => {
    const visual = issue({ file: undefined, line: undefined, url: 'https://example.test/',
      category: 'ui', rule: 'ui.overlap', viewport: 'mobile', selector: 'nav > a',
      title: '<b>başlık</b>\n# Yeni başlık', evidence: 'sol | sağ', screenshot: 'screenshots/mobile.png' });
    const report = makeReport(target, [], 0, [
      visual, { ...visual, viewport: 'desktop', screenshot: 'screenshots/../outside.png' },
      { ...visual, viewport: 'tablet', screenshot: 'https://example.test/remote.png' },
    ], [], date);
    expect(report.findings).toHaveLength(3);
    const md = markdown(report);
    expect(md).toContain('&lt;b&gt;başlık&lt;/b&gt;');
    expect(md).not.toContain('\n# Yeni başlık');
    expect(md).toContain('sol \\| sağ');
    expect(md).toContain('[Ekran görüntüsü](screenshots/mobile.png)');
    expect(md).not.toContain('outside.png');
    expect(md).not.toContain('remote.png');
    for (const f of report.findings) expect(md).toContain(f.id);
  });

  it('bounds health and handles empty reports', () => {
    const empty = makeReport(target, [], 0, [], [], date);
    expect(empty.summary.health).toBe(100);
    expect(empty.priority).toEqual([]);
    expect(markdown(empty)).toContain('bulgu çıkmadı');
    const many = [
      ...Array.from({ length: 5 }, (_, line) => issue({ severity: 'critical', line: line + 1 })),
      ...Array.from({ length: 10 }, (_, line) => issue({ severity: 'high', line: line + 10 })),
      ...Array.from({ length: 10 }, (_, line) => issue({ severity: 'medium', line: line + 100 })),
      ...Array.from({ length: 20 }, (_, line) => issue({ severity: 'low', line: line + 1000 })),
    ];
    expect(makeReport(target, [], 1, many, [], date).summary.health).toBe(0);
  });

  it('applies per-severity penalty caps to health calculation', () => {
    // 5000 low only → health 90
    const lowOnly = Array.from({ length: 5000 }, (_, i) => issue({ severity: 'low', line: i + 1 }));
    expect(makeReport(target, [], 1, lowOnly, [], date).summary.health).toBe(90);

    // 1 critical + 146 high + 298 medium + 4447 low → health 25 (100 - 15 - 30 - 20 - 10)
    const mixed = [
      issue({ severity: 'critical', line: 1 }),
      ...Array.from({ length: 146 }, (_, i) => issue({ severity: 'high', line: i + 2 })),
      ...Array.from({ length: 298 }, (_, i) => issue({ severity: 'medium', line: i + 150 })),
      ...Array.from({ length: 4447 }, (_, i) => issue({ severity: 'low', line: i + 500 })),
    ];
    expect(makeReport(target, [], 1, mixed, [], date).summary.health).toBe(25);

    // 2 high → 86
    const twoHigh = [
      issue({ severity: 'high', line: 1 }),
      issue({ severity: 'high', line: 2 }),
    ];
    expect(makeReport(target, [], 1, twoHigh, [], date).summary.health).toBe(86);

    // 3 critical → 60
    const threeCritical = [
      issue({ severity: 'critical', line: 1 }),
      issue({ severity: 'critical', line: 2 }),
      issue({ severity: 'critical', line: 3 }),
    ];
    expect(makeReport(target, [], 1, threeCritical, [], date).summary.health).toBe(60);
  });

  it('includes rule identifier in markdown location line', () => {
    const report = makeReport(target, [], 1, [
      issue({ rule: 'security.literal-secret', category: 'security', severity: 'high', file: 'src/app.ts', line: 7 }),
    ], [], date);
    const md = markdown(report);
    expect(md).toContain('  - Konum · src/app.ts:7 · kural security.literal-secret');
  });

  it('markdown separates false positives and escapes triage reason', () => {
    const report = makeReport(target, [], 1, [
      issue({ rule: 'security.literal-secret', category: 'security', severity: 'high', file: 'src/fp.ts', line: 3 }),
      issue({ rule: 'security.eval', category: 'security', severity: 'critical', file: 'src/real.ts', line: 9 }),
    ], [], date);
    report.findings[0] = {
      ...report.findings[0]!,
      triage: { verdict: 'gerçek', reason: 'Gerçek tehlike' },
    };
    report.findings[1] = {
      ...report.findings[1]!,
      triage: { verdict: 'yanlış alarm', reason: 'Test <script> | *örnek* [x]' },
    };
    const md = markdown(report);
    expect(md).toContain('  - Model: yanlış alarm');
    const fpSection = md.split('## Model yanlış alarm dedi')[1]!.split('## Öncelikli aksiyon planı')[0]!;
    expect(fpSection.trimStart().startsWith('Bilgi amaçlıdır: bulgu silinmez, puan değişmez; taranan kod modeli yönlendirebilir, kararı doğrulayın.')).toBe(true);
    expect(fpSection).toContain('SEC-002');
    expect(fpSection).toContain('security.literal-secret');
    expect(fpSection).toContain('src/fp.ts:3');
    expect(fpSection).toContain('Test &lt;script&gt; \\| \\*örnek\\* \\[x\\]');
    expect(fpSection).not.toContain('SEC-001');
  });
});
