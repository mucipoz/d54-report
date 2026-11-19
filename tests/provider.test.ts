import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadProvider } from '../src/llm/provider.js';
import { review } from '../src/llm/review.js';
import type { SourceFile } from '../src/types.js';

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
