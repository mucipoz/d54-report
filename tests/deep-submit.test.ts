import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runScan } from '../src/engine.js';
import { readReport } from '../src/reporters/read.js';
import { prepareDeepReview } from '../src/deep/session.js';
import { deepCategories, deepFindingSchema, submitDeepReview } from '../src/deep/submit.js';

describe('deep/submit', () => {
  let temp: string;
  let project: string;
  let out: string;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'd54-deep-submit-'));
    project = join(temp, 'proj');
    out = join(temp, 'reports');
    await mkdir(join(project, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  it('exposes deepCategories in exact priority order and validates deepFindingSchema', () => {
    expect(deepCategories).toEqual([
      'authz',
      'business-rule',
      'race',
      'async',
      'null',
      'logic',
      'boundary',
      'error-handling',
    ]);
    const valid = deepFindingSchema.safeParse({
      category: 'logic',
      file: 'src/order.ts',
      line: 3,
      quote: 'if (qty > maxQty)',
      title: 'Ters sınır koşulu',
      impact: 'Geçerli sipariş reddedilir.',
      advice: 'Koşulu düzeltin.',
      severity: 'high',
      verdict: 'confirmed',
      reason: 'Fonksiyon içinde başka kontrol yok.',
    });
    expect(valid.success).toBe(true);
  });

  it('rejects each invalid case with Turkish reason, caps severity, deduplicates, and merges into previous scan report', async () => {
    const orderCode = [
      'export function processOrder(user: { isAdmin: boolean }, qty: number) {',
      '  const apiKey = "sk_live_HIDDEN_KEY_999999";',
      '  if (qty < 0 || qty === 0) {',
      '    return { ok: true, charged: qty * 100 };',
      '  }',
      '  if (!user.isAdmin) {',
      '    return { ok: true, adminBypass: true };',
      '  }',
      '  return { ok: false };',
      '}',
    ].join('\n') + '\n';

    const mutableCode = [
      'export function updateWallet(balance: number, delta: number) {',
      '  return balance - delta;',
      '}',
    ].join('\n') + '\n';

    await writeFile(join(project, 'src/order.ts'), orderCode);
    await writeFile(join(project, 'src/wallet.ts'), mutableCode);
    // Add a file with a static issue so runScan produces an initial finding to preserve
    await writeFile(join(project, 'src/legacy.js'), 'export function run(x) { return eval(x); }\n');

    const initialScan = await runScan({ path: project, out, browser: false });
    expect(initialScan.report.findings.length).toBeGreaterThanOrEqual(1);
    const initialHealth = initialScan.report.summary.health;
    const initialRule = initialScan.report.findings[0]!.rule;

    const prep = await prepareDeepReview(project, out, {});

    // Modify wallet.ts AFTER prepare to trigger "kaynak değişti" (Review Focus #2)
    await writeFile(
      join(project, 'src/wallet.ts'),
      'export function updateWallet(balance: number, delta: number) {\n  return balance + delta;\n}\n',
    );

    const base = {
      category: 'logic',
      file: 'src/order.ts',
      line: 4,
      quote: 'return { ok: true, charged: qty * 100 };',
      title: 'Sıfır veya negatif miktarda başarılı sipariş dönüyor',
      impact: 'Negatif veya sıfır tutarla sipariş onaylanır.',
      advice: 'Negatif veya sıfır miktarda hata döndürün.',
      severity: 'critical',
      verdict: 'confirmed',
      reason: 'Satır 3-4 doğrudan ok:true döndürüyor.',
    };

    const items: unknown[] = [
      // 0: invalid schema
      { category: 'unknown-cat', file: 'src/order.ts', line: 0 },
      // 1: not confirmed
      { ...base, verdict: 'uncertain' },
      // 2: unknown file
      { ...base, file: 'src/nonexistent.ts' },
      // 3: source changed after prepare
      { ...base, file: 'src/wallet.ts', line: 2, quote: 'return balance - delta;' },
      // 4: out-of-range line
      { ...base, line: 999 },
      // 5: masked secret line (line 2)
      { ...base, line: 2, quote: 'const apiKey' },
      // 6: quote does not match line 4
      { ...base, quote: 'completelyDifferentCall()' },
      // 7: text > 800 chars
      { ...base, title: 'u'.repeat(801) },
      // 8: text contains secret pattern
      { ...base, advice: 'Set password: superSecretValue and bearer abcdef123456' },
      // 9: VALID logic finding with severity 'critical' -> capped to 'high'
      base,
      // 10: DUPLICATE (same file + line + category) -> first stays
      { ...base, title: 'İkinci tekrar başlık' },
      // 11: VALID authz finding with severity 'critical' -> stays 'critical' & category 'security'
      {
        category: 'authz',
        file: 'src/order.ts',
        line: 7,
        quote: 'return   { ok: true,   adminBypass: true };', // whitespace normalized match!
        title: 'Yetkisiz kullanıcıya adminBypass veriliyor',
        impact: 'Admin olmayan kullanıcı yetkili işlem yapar.',
        advice: 'Yetkisiz durumda erişimi reddedin.',
        severity: 'critical',
        verdict: 'confirmed',
        reason: '!user.isAdmin dalında ok:true dönüyor.',
      },
    ];

    const res = await submitDeepReview(project, out, prep.session, items, { uncertain: 2, rejected: 3 });

    expect(res.accepted).toBe(2);
    expect(res.rejected).toHaveLength(10);
    expect(res.rejected.map(r => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 10]);
    expect(res.rejected[3]!.reason).toContain('kaynak değişti');
    expect(res.rejected[9]!.reason).toBe('tekrar');

    // Previous scan findings are preserved
    expect(res.report.findings.some(f => f.rule === initialRule)).toBe(true);

    // Logic finding: rule review.deep.logic, category bugs, severity capped critical -> high, first title kept
    const logicFinding = res.report.findings.find(f => f.rule === 'review.deep.logic');
    expect(logicFinding).toBeDefined();
    expect(logicFinding!.category).toBe('bugs');
    expect(logicFinding!.severity).toBe('high');
    expect(logicFinding!.title).toBe('Derin inceleme (ajan) · Sıfır veya negatif miktarda başarılı sipariş dönüyor');
    expect(logicFinding!.evidence).toBe('Satır 4: return { ok: true, charged: qty * 100 };');

    // Authz finding: rule review.deep.authz, category security, severity remains critical
    const authzFinding = res.report.findings.find(f => f.rule === 'review.deep.authz');
    expect(authzFinding).toBeDefined();
    expect(authzFinding!.category).toBe('security');
    expect(authzFinding!.severity).toBe('critical');

    // Health score recalculated downward and saved report on disk is valid
    expect(res.report.summary.health).toBeLessThan(initialHealth);
    expect(res.report.coverage.some(c => c.includes('2 kabul, 10 ret, ajan bildirimi 2 belirsiz / 3 çürütülen'))).toBe(true);
    expect(res.report.coverage.some(c => c.includes('Ajan doğrulamasını D54 Report kanıtlayamaz'))).toBe(true);

    const saved = await readReport(res.prefix + '.json');
    expect(saved.summary.total).toBe(res.report.summary.total);
  });

  it('creates a standalone report when no prior scan report exists in out', async () => {
    await writeFile(
      join(project, 'src/auth.ts'),
      'export function canEdit(role: string) {\n  return role !== "admin";\n}\n',
    );
    const prep = await prepareDeepReview(project, out, {});
    const res = await submitDeepReview(project, out, prep.session, [
      {
        category: 'authz',
        file: 'src/auth.ts',
        line: 2,
        quote: 'return role !== "admin";',
        title: 'Admin rolü ters kontrol ediliyor',
        impact: 'Yetkisiz kullanıcılar düzenleme yapabilir.',
        advice: 'role === "admin" olarak değiştirin.',
        severity: 'critical',
        verdict: 'confirmed',
        reason: '!== işleci yetkiyi tersine çeviriyor.',
      },
    ]);
    expect(res.accepted).toBe(1);
    expect(res.report.filesScanned).toBe(0);
    expect(res.report.stack).toEqual([]);
    expect(res.report.findings).toHaveLength(1);
    expect(res.report.findings[0]!.id).toBe('SEC-001');
  });

  it('rejects quotes shorter than 8 normalized chars or without alphanumeric characters', async () => {
    await writeFile(
      join(project, 'src/short.ts'),
      'export function run() {\n  const a = 1;\n  return { a };\n}\n',
    );
    const prep = await prepareDeepReview(project, out, {});
    const base = {
      category: 'logic',
      file: 'src/short.ts',
      line: 3,
      title: 'Kısa alıntı testi',
      impact: 'Test etkisi.',
      advice: 'Test önerisi.',
      severity: 'medium',
      verdict: 'confirmed',
      reason: 'Test gerekçesi.',
    };
    const res = await submitDeepReview(project, out, prep.session, [
      { ...base, quote: 'a' },
      { ...base, quote: '}' },
      { ...base, quote: '        ' },
      { ...base, quote: ';;;;;;;;' },
    ]);
    expect(res.accepted).toBe(0);
    expect(res.rejected).toEqual([
      { index: 0, reason: 'alıntı çok kısa' },
      { index: 1, reason: 'alıntı çok kısa' },
      { index: 2, reason: 'alıntı çok kısa' },
      { index: 3, reason: 'alıntı çok kısa' },
    ]);
  });

  it('rejects findings already present in previous report with "zaten raporlu" and in-batch duplicates with "tekrar"', async () => {
    await writeFile(
      join(project, 'src/auth.ts'),
      'export function canEdit(role: string) {\n  return role !== "admin";\n}\n',
    );
    const prep = await prepareDeepReview(project, out, {});
    const finding = {
      category: 'authz',
      file: 'src/auth.ts',
      line: 2,
      quote: 'return role !== "admin";',
      title: 'Admin rolü ters kontrol ediliyor',
      impact: 'Yetkisiz kullanıcılar düzenleme yapabilir.',
      advice: 'role === "admin" olarak değiştirin.',
      severity: 'critical',
      verdict: 'confirmed',
      reason: '!== işleci yetkiyi tersine çeviriyor.',
    };

    const first = await submitDeepReview(project, out, prep.session, [finding, finding]);
    expect(first.accepted).toBe(1);
    expect(first.rejected).toEqual([{ index: 1, reason: 'tekrar' }]);

    const second = await submitDeepReview(project, out, prep.session, [finding]);
    expect(second.accepted).toBe(0);
    expect(second.rejected).toEqual([{ index: 0, reason: 'zaten raporlu' }]);
    expect(second.report.findings.filter(f => f.rule === 'review.deep.authz')).toHaveLength(1);
  });

  it('accepts authz line containing token identifier in quote', async () => {
    await writeFile(
      join(project, 'src/guard.ts'),
      "export function guard(token: { role: string }) {\n  if (token.role !== 'admin') {\n    return false;\n  }\n  return true;\n}\n",
    );
    const prep = await prepareDeepReview(project, out, {});
    const res = await submitDeepReview(project, out, prep.session, [
      {
        category: 'authz',
        file: 'src/guard.ts',
        line: 2,
        quote: "if (token.role !== 'admin') {",
        title: 'Rol kontrolü katı eşitlikle sınırlandırılmış',
        impact: 'Yetki kontrolü yanlış rollere izin verebilir.',
        advice: 'İzin tabanlı merkezi yetki denetimi kullanın.',
        severity: 'high',
        verdict: 'confirmed',
        reason: 'Doğrudan rol dizesi karşılaştırılıyor.',
      },
    ]);
    expect(res.accepted).toBe(1);
    expect(res.rejected).toEqual([]);
  });

  it('rejects findings whose quote contains a real secret (JWT or AWS key)', async () => {
    await writeFile(
      join(project, 'src/leak.ts'),
      "export const aws = 'AKIA1234567890ABCDEF';\nexport const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';\n",
    );
    const prep = await prepareDeepReview(project, out, {});
    const res = await submitDeepReview(project, out, prep.session, [
      {
        category: 'authz',
        file: 'src/leak.ts',
        line: 1,
        quote: "export const aws = 'AKIA1234567890ABCDEF';",
        title: 'Sabit anahtar gömülü',
        impact: 'Yetkisiz erişim riski doğar.',
        advice: 'Anahtarı ortam değişkenine taşıyın.',
        severity: 'high',
        verdict: 'confirmed',
        reason: 'Kaynak kodda sabit anahtar bulunuyor.',
      },
      {
        category: 'authz',
        file: 'src/leak.ts',
        line: 2,
        quote: "export const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';",
        title: 'Sabit belirteç gömülü',
        impact: 'Oturum ele geçirilebilir.',
        advice: 'Belirteci çalışma zamanında üretin.',
        severity: 'high',
        verdict: 'confirmed',
        reason: 'Kaynak kodda sabit belirteç bulunuyor.',
      },
    ]);
    expect(res.accepted).toBe(0);
    expect(res.rejected).toHaveLength(2);
  });

  // Saha testi 20 Kas: "resetPassword" geçen açıklama yanlışlıkla sır sayılıp reddedildi.
  it('accepts prose that names password/token identifiers but rejects prose carrying a real secret value', async () => {
    await writeFile(join(project, 'src/audit.ts'), "export function log(actor: unknown) {\n  return { actor: actor, status: 'error' };\n}\n");
    const prep = await prepareDeepReview(project, out, {});
    const base = {
      category: 'logic', file: 'src/audit.ts', line: 2, quote: "return { actor: actor, status: 'error' };",
      title: 'Hata kaydında aktör atlanıyor', advice: 'auditActor kullanın.', severity: 'low', verdict: 'confirmed',
    };
    const res = await submitDeepReview(project, out, prep.session, [
      { ...base, impact: 'users.resetPassword hata verince token sahibi kayıtta Bilinmeyen görünür.', reason: 'password sıfırlama yolu.' },
      { ...base, line: 1, quote: 'export function log(actor: unknown) {', impact: 'Örnek: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', reason: 'Sır taşıyan açıklama.' },
    ]);
    expect(res.accepted).toBe(1);
    expect(res.rejected).toEqual([{ index: 1, reason: 'metin sır deseni içeriyor' }]);
  });
});
