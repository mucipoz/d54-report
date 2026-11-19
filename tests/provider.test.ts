import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadProvider } from '../src/llm/provider.js';
import { review } from '../src/llm/review.js';
import { triage } from '../src/llm/triage.js';
import { findingSchema } from '../src/reporters/read.js';
import type { Finding, SourceFile } from '../src/types.js';

let dir: string;
let received: { path?: string; method?: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[];
let base: string;
let close: () => Promise<void>;
let status: number;
let content: unknown;

beforeEach(async () => {
  for (const key of ['D54_PROVIDER', 'D54_BASE_URL', 'D54_MODEL', 'D54_API_KEY', 'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GLM_API_KEY', 'OPENAI-COMPATIBLE_API_KEY']) vi.stubEnv(key, undefined);
  dir = await mkdtemp(join(tmpdir(), 'd54-provider-'));
  received = [];
  status = 200;
  content = { choices: [{ message: { content: 'Yerel yanıt' } }] };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ path: request.url, method: request.method, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(content));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Yerel HTTP dinleyicisi başlatılamadı.');
  base = 'http://127.0.0.1:' + address.port + '/v1';
  close = () => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
  await rm(dir, { recursive: true, force: true });
});

async function configured(provider: string, key = '') {
  const file = join(dir, 'operator.json');
  const llm = { provider, model: 'fixture-model', base_url: base, api_key: key };
  await writeFile(file, JSON.stringify({ llm }));
  return loadProvider(file);
}

it.each(['openai', 'deepseek', 'glm', 'openai-compatible'])('uses the local chat protocol for %s', async name => {
  const key = name === 'openai-compatible' ? '' : 'fixture-credential';
  const provider = await configured(name, key);
  expect(await provider!.complete('system message', 'request')).toBe('Yerel yanıt');
  expect(received).toHaveLength(1);
  const call = received[0]!;
  expect(call.path).toBe('/v1/chat/completions');
  expect(call.method).toBe('POST');
  expect(call.headers['content-type']).toContain('application/json');
  expect(call.headers.authorization).toBe(key ? 'Bearer ' + key : undefined);
  expect(call.body).toMatchObject({ model: 'fixture-model', messages: [
    { role: 'system', content: 'system message' }, { role: 'user', content: 'request' },
  ] });
});

it('uses the Messages envelope and extracts only Anthropic text blocks', async () => {
  content = { content: [{ type: 'text', text: 'Bir' }, { type: 'tool_use', id: 'ignored' }, { type: 'text', text: 'İki' }] };
  const provider = await configured('anthropic', 'fixture-credential');
  expect(await provider!.complete('system message', 'request')).toBe('Bir\nİki');
  expect(received[0]).toMatchObject({
    path: '/v1/messages', method: 'POST',
    headers: { 'x-api-key': 'fixture-credential', 'anthropic-version': '2023-06-01' },
    body: { model: 'fixture-model', system: 'system message', messages: [{ role: 'user', content: 'request' }] },
  });
  expect(received[0]!.headers.authorization).toBeUndefined();
});

it('loads adjacent dotenv values and prioritizes process environment', async () => {
  const config = join(dir, 'operator.json');
  await writeFile(config, JSON.stringify({ provider: 'none', model: 'from-config' }));
  await writeFile(join(dir, '.env'), 'D54_PROVIDER=openai-compatible\nD54_BASE_URL=' + base + '\nD54_MODEL=from-dotenv\n');
  vi.stubEnv('D54_MODEL', 'from-environment');
  const provider = await loadProvider(config);
  await provider!.complete('s', 'q');
  expect(received[0]!.body.model).toBe('from-environment');
  vi.stubEnv('D54_PROVIDER', 'none');
  expect(await loadProvider(config)).toBeUndefined();
});

it('fails clearly on HTTP errors, malformed envelopes and unsupported configuration', async () => {
  const provider = await configured('openai-compatible');
  status = 503;
  content = { error: 'PRIVATE_FIXTURE_MARKER' };
  await expect(provider!.complete('s', 'q')).rejects.toThrow(/^Model HTTP 503$/);
  status = 200;
  content = { choices: [] };
  await expect(provider!.complete('s', 'q')).rejects.toThrow('metin');
  await expect(configured('other')).rejects.toThrow('D54_PROVIDER');
  await expect(configured('anthropic')).rejects.toThrow('API');
  await expect(loadProvider(join(dir, 'absent.json'))).rejects.toThrow('bulunamadı');
});

it('sends structural source context and accepts only findings tied to supplied lines', async () => {
  const file = (path: string, text: string): SourceFile => ({ path, text, size: Buffer.byteLength(text) });
  const sources = [
    file('src/service.ts', ['function check(value) {', '  // PRIVATE_COMMENT', '  const password = "PRIVATE_PASSWORD";',
      '  if (value) return "PRIVATE_LITERAL";', '  return false;', '}'].join('\n')),
    file('tests/private.ts', 'function PRIVATE_TEST() {}'), file('.env', 'PRIVATE_ENV=example'),
  ];
  const candidate = { dimension: 'business-logic', title: 'Dal denetimi', impact: 'Karar yolu etkilenir.',
    advice: 'Koşulu inceleyin.', file: 'src/service.ts', line: 4 };
  const complete = vi.fn(async (_system: string, _input: string) => JSON.stringify({ findings: [candidate, { ...candidate, file: 'other.ts' },
    { ...candidate, line: 3 }, { ...candidate, dimension: 'unknown' }, { ...candidate, advice: 'password disclosure' }] }));
  const result = await review({ complete }, sources);
  expect(complete).toHaveBeenCalledOnce();
  const input = complete.mock.calls[0]![1];
  expect(input).not.toContain('PRIVATE_');
  expect(JSON.parse(input)).toEqual([{ file: 'src/service.ts', lines: [
    [1, 'function check(value) {'], [4, 'if (value) return "";'], [5, 'return false;'],
  ] }]);
  expect(result.issues).toHaveLength(1);
  expect(result.issues[0]).toMatchObject({ rule: 'review.business-logic', severity: 'medium', file: 'src/service.ts', line: 4 });
  await expect(review({ complete: async () => '{}' }, sources)).rejects.toThrow('şeması');
});

it('requires explicit endpoint approval before combining project configuration with a process credential', async () => {
  const config = join(dir, 'd54-report.config.json');
  await writeFile(config, JSON.stringify({ provider: 'openai-compatible', model: 'fixture', base_url: base }));
  vi.stubEnv('D54_API_KEY', 'fixture-credential');
  const entry = new URL('../dist/llm/provider.js', import.meta.url).href;
  // Isolate implicit config discovery in the fixture's cwd. Only construct the provider.
  const script = 'const { loadProvider } = await import(process.argv[1]); try { await loadProvider(); } catch { process.exitCode = 25; }';
  await expect(promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, entry], {
    cwd: dir, env: { D54_API_KEY: 'fixture-credential' }, timeout: 10_000,
  })).rejects.toMatchObject({ code: 25 });
  expect(received).toHaveLength(0);

  const authorized = await loadProvider(config);
  expect(await authorized!.complete('s', 'q')).toBe('Yerel yanıt');
  expect(received).toHaveLength(1);
  expect(received[0]!.headers.authorization).toBe('Bearer fixture-credential');
});

it('reports malformed model configuration without quoting its contents', async () => {
  const path = join(dir, 'operator.json');
  await writeFile(path, '{"model":FIXTURE_PLAIN_MARKER}');
  const error = await loadProvider(path).then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toMatch(/FIXTURE_PLAIN_MARKER|\{"model"/);
});

it('keeps executable lines while excluding JS template text and Python docstrings', async () => {
  const code = [
    { path: 'src/clock.js', text: ['function ready(value) {', '  const label = `',
      'if TEMPLATE_FIXTURE_LINE', '  `;', '  return value;', '}'].join('\n') },
    { path: 'src/clock.py', text: ['def ready(value):', '    """',
      'return DOCSTRING_FIXTURE_LINE', '    """', '    return value'].join('\n') },
  ];
  const complete = vi.fn(async (_system: string, _input: string) => '{"findings":[]}');
  await review({ complete }, code.map(f => ({ ...f, size: Buffer.byteLength(f.text) })));
  expect(complete).toHaveBeenCalledOnce();
  const input = complete.mock.calls[0]![1];
  expect(input).not.toMatch(/TEMPLATE_FIXTURE_LINE|DOCSTRING_FIXTURE_LINE/);
  const outlines = JSON.parse(input) as { file: string; lines: [number, string][] }[];
  for (const { path } of code) {
    const lines = outlines.find(o => o.file === path)?.lines;
    expect(lines).toEqual(expect.arrayContaining([
      [1, expect.stringMatching(/ready\s*\(value\)/)], [5, expect.stringMatching(/return\s+value/)],
    ]));
  }
});

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'SEC-001',
    rule: 'security.secret-literal',
    category: 'security',
    severity: 'high',
    title: 'Sabit gizli anahtar şüphesi',
    file: 'src/app.ts',
    line: 20,
    evidence: 'Satırda gizli değer bulundu',
    impact: 'Yetkisiz erişim riski',
    advice: 'Ortam değişkeni kullanın',
    ...overrides,
  };
}

function makeSource(path: string, text: string): SourceFile {
  return { path, text, size: Buffer.byteLength(text) };
}

it('attaches verdict from model only for critical/high findings and exposes model name on provider', async () => {
  const provider = await configured('openai-compatible');
  expect(provider!.model).toBe('fixture-model');
  const anthropicProvider = await configured('anthropic', 'fixture-credential');
  expect(anthropicProvider!.model).toBe('fixture-model');

  const lines = Array.from({ length: 45 }, (_, i) => `const line_${i + 1} = ${i + 1};`);
  const files = [makeSource('src/app.ts', lines.join('\n'))];
  const findings: Finding[] = [
    makeFinding({ id: 'SEC-001', severity: 'critical', line: 20 }),
    makeFinding({ id: 'SEC-002', severity: 'high', line: 25 }),
    makeFinding({ id: 'SEC-003', severity: 'medium', line: 5 }),
    makeFinding({ id: 'SEC-004', severity: 'low', line: 10 }),
  ];

  const complete = vi.fn(async (system: string, input: string) => {
    expect(system).toMatch(/VERİ|DATA/i);
    expect(input).toContain('<<<KOD_BASLANGIC>>>');
    expect(input).toContain('<<<KOD_BITIS>>>');
    return JSON.stringify({ verdict: 'gerçek', reason: 'Doğrulanmış sorun', extraField: 'ignored' });
  });

  const res = await triage({ model: 'fixture-model', complete }, findings, files);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(res.findings[0]!.triage).toEqual({ verdict: 'gerçek', reason: 'Doğrulanmış sorun' });
  expect(Object.keys(res.findings[0]!.triage!)).toEqual(['verdict', 'reason']);
  expect(res.findings[1]!.triage).toEqual({ verdict: 'gerçek', reason: 'Doğrulanmış sorun' });
  expect(res.findings[2]!.triage).toBeUndefined();
  expect(res.findings[3]!.triage).toBeUndefined();
  expect(findings[0]!.triage).toBeUndefined();
  expect(res.notes).toContain('Triyaj: 2 bulgu modele gönderildi (sınır 30). Model: fixture-model');

  // Check ±15 line window for line 20 (lines 5..35, not 4 or 36)
  const firstInput = complete.mock.calls[0]![1];
  expect(firstInput).toContain('5: const line_5 = 5;');
  expect(firstInput).toContain('35: const line_35 = 35;');
  expect(firstInput).not.toContain('4: const line_4 = 4;');
  expect(firstInput).not.toContain('36: const line_36 = 36;');

  // Verify schema accepts triage field
  expect(findingSchema.parse(res.findings[0])).toMatchObject({ id: 'SEC-001', triage: { verdict: 'gerçek', reason: 'Doğrulanmış sorun' } });
});

it('masks secret before sending to provider and omits Model suffix when model is absent', async () => {
  const fakeAwsKey = 'AKIA' + 'IOSFODNN7EXAMPLE';
  const fakePass = 's3cr3t' + '_fixture_pw_99';
  const files = [
    makeSource('src/config.ts', [
      'const header = true;',
      `const awsKey = "${fakeAwsKey}";`,
      `const dbPassword = "${fakePass}";`,
      'export { awsKey, dbPassword };',
    ].join('\n')),
  ];
  const findings = [
    makeFinding({
      id: 'SEC-010',
      file: 'src/config.ts',
      line: 2,
      evidence: `Anahtar ${fakeAwsKey} bulundu`,
    }),
  ];

  const complete = vi.fn(async (_system: string, input: string) => {
    expect(input).not.toContain(fakeAwsKey);
    expect(input).not.toContain(fakePass);
    expect(input).toContain('<gizli>');
    return JSON.stringify({ verdict: 'yanlış alarm', reason: 'Örnek anahtar' });
  });

  const res = await triage({ complete }, findings, files);
  expect(complete).toHaveBeenCalledOnce();
  expect(res.findings[0]!.triage).toEqual({ verdict: 'yanlış alarm', reason: 'Örnek anahtar' });
  expect(res.notes).toContain('Triyaj: 1 bulgu modele gönderildi (sınır 30).');
  expect(res.notes.join('\n')).not.toContain('Model:');
});

it('unparseable reply is belirsiz and sanitizes verdict/reason fields', async () => {
  const files = [makeSource('src/a.ts', 'const x = 1;\nconst y = 2;')];
  const findings = [
    makeFinding({ id: 'SEC-001', file: 'src/a.ts', line: 1 }),
    makeFinding({ id: 'SEC-002', file: 'src/a.ts', line: 2 }),
    makeFinding({ id: 'SEC-003', file: 'src/a.ts', line: 1, rule: 'security.other' }),
  ];

  const replies = [
    'bu geçersiz json yanıtı',
    JSON.stringify({ verdict: 'uydurma', reason: 'Satır1\nSatır2\t' + 'a'.repeat(350), extra: 'nope' }),
    '```json\n{"verdict":"belirsiz","reason":"Kapsam yetersiz"}\n```',
  ];
  let idx = 0;
  const complete = vi.fn(async () => replies[idx++]!);

  const res = await triage({ model: 'm1', complete }, findings, files);
  expect(res.findings[0]!.triage).toEqual({ verdict: 'belirsiz', reason: 'model cevabı okunamadı' });
  expect(res.findings[1]!.triage!.verdict).toBe('belirsiz');
  expect(res.findings[1]!.triage!.reason.length).toBe(300);
  expect(res.findings[1]!.triage!.reason).not.toMatch(/[\x00-\x1f\x7f]/);
  expect(Object.keys(res.findings[1]!.triage!)).toEqual(['verdict', 'reason']);
  expect(res.findings[2]!.triage).toEqual({ verdict: 'belirsiz', reason: 'Kapsam yetersiz' });
});

it('respects limit and bounds context to 4000 characters', async () => {
  const longLine = 'const payload = "' + 'x'.repeat(5000) + '";';
  const files = [makeSource('src/big.ts', longLine)];
  const findings = [
    makeFinding({ id: 'SEC-001', file: 'src/big.ts', line: 1 }),
    makeFinding({ id: 'SEC-002', file: 'src/big.ts', line: 1 }),
    makeFinding({ id: 'SEC-003', file: 'src/big.ts', line: 1 }),
  ];

  const complete = vi.fn(async (_s: string, input: string) => {
    const start = input.indexOf('<<<KOD_BASLANGIC>>>\n') + '<<<KOD_BASLANGIC>>>\n'.length;
    const end = input.indexOf('\n<<<KOD_BITIS>>>');
    const contextBody = input.slice(start, end);
    expect(contextBody.length).toBeLessThanOrEqual(4000);
    return JSON.stringify({ verdict: 'gerçek', reason: 'Sorun var' });
  });

  const res = await triage({ model: 'm1', complete }, findings, files, 2);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(res.findings).toHaveLength(3);
  expect(res.findings[0]!.triage).toBeDefined();
  expect(res.findings[1]!.triage).toBeDefined();
  expect(res.findings[2]!.triage).toBeUndefined();
  expect(res.notes).toContain('Triyaj: 2 bulgu modele gönderildi (sınır 2). Model: m1');
});

it('never removes findings when provider fails or when finding file is absent from files', async () => {
  const files = [makeSource('src/present.ts', 'const a = 1;\nconst b = 2;')];
  const findings = [
    makeFinding({ id: 'SEC-001', severity: 'critical', file: undefined, url: 'https://example.com' }),
    makeFinding({ id: 'SEC-002', severity: 'high', file: 'package-lock.json', line: 1 }),
    makeFinding({ id: 'SEC-003', severity: 'critical', file: 'src/present.ts', line: 1 }),
    makeFinding({ id: 'SEC-004', severity: 'high', file: 'src/present.ts', line: 2 }),
    makeFinding({ id: 'UI-001', category: 'ui', severity: 'medium', file: 'src/present.ts', line: 1 }),
  ];

  const complete = vi.fn()
    .mockRejectedValueOnce(new Error('timeout'))
    .mockResolvedValueOnce(JSON.stringify({ verdict: 'yanlış alarm', reason: 'Güvenli' }));

  const res = await triage({ model: 'm1', complete }, findings, files, 1);
  // SEC-001 and SEC-002 have no file in files -> skipped (not consuming limit!)
  // Wait: SEC-003 fails and consumes 1 of limit=1, so SEC-004 is over limit; let's test with limit=2 in same test or separate
  expect(res.findings.map(f => f.id)).toEqual(['SEC-001', 'SEC-002', 'SEC-003', 'SEC-004', 'UI-001']);
  expect(res.findings[0]!.triage).toBeUndefined();
  expect(res.findings[1]!.triage).toBeUndefined();
  expect(res.findings[2]!.triage).toBeUndefined();
  expect(res.notes.some(n => /hata|zaman aşımı/i.test(n) && n.includes('1'))).toBe(true);
  expect(res.notes.some(n => n.includes('2') && /bağlam|dosya/i.test(n))).toBe(true);

  const complete2 = vi.fn()
    .mockRejectedValueOnce(new Error('timeout'))
    .mockResolvedValueOnce(JSON.stringify({ verdict: 'yanlış alarm', reason: 'Güvenli' }));
  const res2 = await triage({ model: 'm1', complete: complete2 }, findings, files, 2);
  expect(complete2).toHaveBeenCalledTimes(2);
  expect(res2.findings[2]!.triage).toBeUndefined();
  expect(res2.findings[3]!.triage).toEqual({ verdict: 'yanlış alarm', reason: 'Güvenli' });
});
