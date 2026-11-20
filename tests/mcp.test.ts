import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import type { Report } from '../src/types.js';
import { previewCommand } from '../src/project-preview.js';

const execFileAsync = promisify(execFile);

const repo = fileURLToPath(new URL('../', import.meta.url));
const original = '<a href="./page.html" target="_blank">Saat</a>\n';

it('resolves the installed preview entry and keeps D54 in control of the listening address', async () => {
  const root = await mkdtemp(join(tmpdir(), 'd54-preview-command-'));
  try {
    const dir = join(root, 'node_modules', 'vite');
    await mkdir(dir, {recursive:true});
    await writeFile(join(dir, 'package.json'), JSON.stringify({bin:{vite:'cli.js'}}));
    await writeFile(join(dir, 'cli.js'), '');
    const manifest = JSON.stringify({scripts:{dev:'vite --mode local --host localhost --port=4000'}});
    expect(await previewCommand(root, manifest)).toEqual({entry:join(dir,'cli.js'), args:['--mode','local'], name:'vite'});
  } finally { await rm(root, {recursive:true, force:true}); }
});

interface ScanResponse {
  summary: Report['summary'];
  report_paths: { json: string; markdown: string };
  critical_high: { severity: string; rule: string; evidence: string; impact: string; advice: string }[];
  critical_high_total: number;
  rule_counts: Record<string, number>;
  coverage: string[];
  browser_unavailable: boolean;
  scan_incomplete: boolean;
  suppressed?: number;
  suppressedKnownCredentials?: number;
}
interface FixResponse {
  patch_paths: string[];
  successful: unknown;
  rolled_back: unknown;
  results: { id: string; status: string; verification?: { stage: string; status: string }[]; patchPath?: string }[];
}

async function patchFiles(folder: string): Promise<string[]> {
  try {
    return (await readdir(join(folder, 'patches'))).filter(file => file.endsWith('.patch'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

it('serves scan, report and verified patch operations over clean JSON-RPC stdio', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'd54-mcp-'));
  const project = join(temp, 'site');
  const client = new Client({ name: 'd54-integration', version: '1.0.0' });
  const protocolErrors: string[] = [];
  client.onerror = error => { protocolErrors.push(error.message); };
  try {
    await mkdir(project);
    await writeFile(join(project, 'page.html'), original);
    await writeFile(join(project, 'clock.cjs'), 'exports.start = tick => setInterval(tick, 1000);\n');
    await writeFile(join(project, 'clock.test.cjs'), [
      "const test = require('node:test');", "const assert = require('node:assert/strict');",
      "test('clock exports a start function', () => assert.equal(typeof require('./clock.cjs').start, 'function'));",
    ].join('\n'));
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'd54-stdio-fixture',
      scripts: { build: 'node --check clock.cjs', test: 'node --test clock.test.cjs' } }));

    const env = { ...getDefaultEnvironment(), D54_PROVIDER: 'invalid-provider-to-detect-unexpected-model-use',
      D54_MCP_TRUSTED_ROOT: project, NO_COLOR: '1' };
    const transport = new StdioClientTransport({
      command: process.execPath, cwd: project, env, stderr: 'inherit',
      args: [join(repo, 'dist/mcp-server.js')],
    });
    await client.connect(transport);
    const catalog = await client.listTools();
    expect(catalog.tools.map(tool => tool.name).sort()).toEqual([
      'd54_deep_review_prepare',
      'd54_deep_review_run',
      'd54_deep_review_submit',
      'd54_fix_findings',
      'd54_get_report',
      'd54_scan_project',
    ]);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const scan = await call('d54_scan_project', { path: project, modules: ['security', 'performance'] });
    expect(scan.isError, JSON.stringify(scan.content)).not.toBe(true);
    const scanned = scan.structuredContent as unknown as ScanResponse;
    expect(scanned.browser_unavailable).toBe(false);
    expect(typeof scanned.scan_incomplete).toBe('boolean');
    expect(scanned).toMatchObject({ summary: { health: expect.any(Number), total: expect.any(Number), counts: expect.any(Object) },
      report_paths: { json: expect.any(String), markdown: expect.any(String) }, critical_high: expect.any(Array), coverage: expect.any(Array) });
    const jsonPath = scanned.report_paths.json;
    const report: Report = JSON.parse(await readFile(jsonPath, 'utf8'));
    expect(scanned.summary).toEqual(report.summary);
    expect(report.findings.map(f => f.category)).toEqual(expect.arrayContaining(['performance', 'security']));
    expect(report.findings.every(f => ['performance', 'security'].includes(f.category))).toBe(true);
    const target = report.findings.find(f => f.rule === 'security.target-blank')!;
    expect(target).toMatchObject({ file: 'page.html', severity: 'low' });
    for (const path of [jsonPath, scanned.report_paths.markdown]) {
      const response = await call('d54_get_report', { report_path: path });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      expect(response.content).toContainEqual({ type: 'text', text: await readFile(scanned.report_paths.markdown, 'utf8') });
    }
    const args = { report_path: jsonPath, ids: [target.id], severity: 'low', mode: 'patch' };
    const dry = await call('d54_fix_findings', { ...args, dry_run: true });
    expect(dry.isError, JSON.stringify(dry.content)).not.toBe(true);
    const dryData = dry.structuredContent as unknown as FixResponse;
    expect(dryData.results).toEqual([expect.objectContaining({ id: target.id, status: 'DRY_RUN' })]);
    expect(dryData.patch_paths).toEqual([]);
    expect(await patchFiles(dirname(jsonPath))).toEqual([]);
    expect(await readFile(join(project, 'page.html'), 'utf8')).toBe(original);
    const fix = await call('d54_fix_findings', { ...args, ids: target.id });
    expect(fix.isError, JSON.stringify(fix.content)).not.toBe(true);
    const fixed = fix.structuredContent as unknown as FixResponse;
    expect(fixed).toHaveProperty('successful');
    expect(fixed).toHaveProperty('rolled_back');
    expect(fixed.patch_paths).toHaveLength(1);
    expect(fixed.results).toEqual([expect.objectContaining({ id: target.id, status: 'PATCH_CREATED' })]);
    expect(fixed.results[0]!.verification).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'build', status: 'passed' }), expect.objectContaining({ stage: 'test', status: 'passed' }),
    ]));
    const patch = await readFile(fixed.patch_paths[0]!, 'utf8');
    expect(patch).toContain('+++ b/page.html');
    expect(patch).toContain('noopener');
    expect(await readFile(join(project, 'page.html'), 'utf8')).toBe(original);

    const malformed = join(dirname(jsonPath), 'd54-report-malformed.json');
    await writeFile(malformed, '{"schemaVersion":');
    const foreign = join(temp, 'foreign.json');
    await writeFile(foreign, '{"message":"PRIVATE_FIXTURE_MARKER"}');
    for (const path of [malformed, foreign]) {
      const response = await call('d54_get_report', { report_path: path });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.content)).not.toContain('PRIVATE_FIXTURE_MARKER');
    }
    const denied = await call('d54_fix_findings', { ...args, mode: 'pr' });
    expect(denied.isError, JSON.stringify(denied.content)).not.toBe(true);
    const deniedData = denied.structuredContent as unknown as FixResponse;
    expect(deniedData.results).toEqual([expect.objectContaining({id: target.id, status: 'PATCH_CREATED'})]);
    expect(deniedData.results[0].verification).toContainEqual(expect.objectContaining({stage: 'pr.verify', status: 'skipped'}));
    expect(deniedData.patch_paths).toEqual(fixed.patch_paths);
    await client.ping();
    expect(protocolErrors).toEqual([]);
  } finally {
    try { await client.close(); } finally { await rm(temp, { recursive: true, force: true }); }
  }
}, 60_000);

async function withMcpClient<T>(cwd: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'd54-integration', version: '1.0.0' });
  const env = { ...getDefaultEnvironment(), D54_PROVIDER: 'invalid-provider', NO_COLOR: '1' };
  const transport = new StdioClientTransport({
    command: process.execPath, cwd, env, stderr: 'inherit',
    args: [join(repo, 'dist/mcp-server.js')],
  });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close();
  }
}

it('limits critical_high to 25 and reports total', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'd54-mcp-limit-'));
  try {
    const lines = Array.from({ length: 35 }, (_, i) => `eval(input_${i});`).join('\n');
    await writeFile(join(temp, 'app.js'), lines + '\n');
    await writeFile(join(temp, 'page.html'), original);
    await withMcpClient(temp, async client => {
      const scan = await client.callTool({ name: 'd54_scan_project', arguments: { path: temp, modules: ['security'] } });
      expect(scan.isError, JSON.stringify(scan.content)).not.toBe(true);
      const res = scan.structuredContent as unknown as ScanResponse;
      expect(res.critical_high).toHaveLength(25);
      expect(res.critical_high_total).toBe(35);
      expect(res.rule_counts['security.dynamic-eval']).toBe(35);
      expect(res.rule_counts['security.target-blank']).toBeUndefined();
      for (const f of res.critical_high) {
        expect(f.evidence.length).toBeLessThanOrEqual(200);
        expect(f.impact.length).toBeLessThanOrEqual(200);
        expect(f.advice.length).toBeLessThanOrEqual(200);
      }
      const saved: Report = JSON.parse(await readFile(res.report_paths.json, 'utf8'));
      expect(saved.findings.filter(f => f.severity === 'high')).toHaveLength(35);
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 60_000);

it('json result under 15000 chars for 200 high findings', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'd54-mcp-200-'));
  try {
    const lines = Array.from({ length: 200 }, (_, i) => `eval(input_${i});`).join('\n');
    await writeFile(join(temp, 'app.js'), lines + '\n');
    await withMcpClient(temp, async client => {
      const scan = await client.callTool({ name: 'd54_scan_project', arguments: { path: temp, modules: ['security'] } });
      expect(scan.isError, JSON.stringify(scan.content)).not.toBe(true);
      const res = scan.structuredContent as unknown as ScanResponse;
      expect(res.critical_high).toHaveLength(25);
      expect(res.critical_high_total).toBe(200);
      const text = (scan.content as { type: string; text: string }[])[0]!.text;
      expect(text.length).toBeLessThan(15000);
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 60_000);

it('warns when reports dir not ignored', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'd54-mcp-git-'));
  try {
    await execFileAsync('git', ['init'], { cwd: temp });
    await writeFile(join(temp, 'app.js'), 'const x = 1;\n');
    await withMcpClient(temp, async client => {
      const scan1 = await client.callTool({ name: 'd54_scan_project', arguments: { path: temp, modules: ['security'] } });
      expect(scan1.isError, JSON.stringify(scan1.content)).not.toBe(true);
      const res1 = scan1.structuredContent as unknown as ScanResponse;
      expect(res1.coverage).toContain("reports/ klasörü git tarafından dışlanmıyor. .gitignore'a 'reports/' ekleyin.");

      await writeFile(join(temp, '.gitignore'), 'reports/\n');
      const scan2 = await client.callTool({ name: 'd54_scan_project', arguments: { path: temp, modules: ['security'] } });
      expect(scan2.isError, JSON.stringify(scan2.content)).not.toBe(true);
      const res2 = scan2.structuredContent as unknown as ScanResponse;
      expect(res2.coverage).not.toContain("reports/ klasörü git tarafından dışlanmıyor. .gitignore'a 'reports/' ekleyin.");
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 60_000);

it('returns suppressed and suppressedKnownCredentials and notes suppressed known credentials in coverage', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'd54-mcp-suppress-'));
  try {
    const awsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    await writeFile(join(temp, 'keys.ts'), `export const k = "${awsKey}";\n`);
    await writeFile(join(temp, 'page.html'), original);
    await writeFile(join(temp, '.d54report-ignore'), '* ** # her şeyi gizle\n');
    await withMcpClient(temp, async client => {
      const scan = await client.callTool({ name: 'd54_scan_project', arguments: { path: temp, modules: ['security'] } });
      expect(scan.isError, JSON.stringify(scan.content)).not.toBe(true);
      const res = scan.structuredContent as unknown as ScanResponse;
      expect(res.summary.total).toBe(0);
      expect(res.suppressed).toBeGreaterThanOrEqual(2);
      expect(res.suppressedKnownCredentials).toBe(1);
      expect(res.coverage).toContain('Bastırma dosyası 1 gerçek biçimli anahtarı gizledi.');
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 60_000);

it('triage requires llm in MCP d54_scan_project', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'd54-mcp-triage-'));
  try {
    await writeFile(join(temp, 'app.js'), 'eval(x);\n');
    await withMcpClient(temp, async client => {
      const scan = await client.callTool({
        name: 'd54_scan_project',
        arguments: { path: temp, modules: ['security'], use_llm: false, triage: true },
      });
      expect(scan.isError).toBe(true);
      const text = (scan.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('use_llm');
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 60_000);

it('serves d54_deep_review_prepare and d54_deep_review_submit via MCP and CLI, rejecting invalid session IDs', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'd54-mcp-deep-'));
  try {
    await mkdir(join(temp, 'src/auth'), { recursive: true });
    await writeFile(
      join(temp, 'src/auth/login.ts'),
      [
        'export function verifyRole(role: string) {',
        '  if (role !== "admin") {',
        '    return { allowed: true };',
        '  }',
        '  return { allowed: false };',
        '}',
      ].join('\n') + '\n',
    );

    await withMcpClient(temp, async client => {
      const badSubmit = await client.callTool({
        name: 'd54_deep_review_submit',
        arguments: { path: temp, session: '../bad', findings: [] },
      });
      expect(badSubmit.isError).toBe(true);

      const missingSubmit = await client.callTool({
        name: 'd54_deep_review_submit',
        arguments: { path: temp, session: '0123456789abcdef', findings: [] },
      });
      expect(missingSubmit.isError).toBe(true);

      const prep = await client.callTool({
        name: 'd54_deep_review_prepare',
        arguments: { path: temp, deep_files: 4, max_chunks: 10 },
      });
      expect(prep.isError, JSON.stringify(prep.content)).not.toBe(true);
      const prepData = prep.structuredContent as {
        session: string;
        chunk_files: string[];
        summary: { files: string[]; chunks: number; skippedMasked: number; notes: string[] };
        instructions: string;
      };
      expect(prepData.session).toMatch(/^[a-f0-9]{16}$/);
      expect(prepData.chunk_files.length).toBeGreaterThanOrEqual(1);
      expect(prepData.summary.files).toEqual(['src/auth/login.ts']);

      const sub = await client.callTool({
        name: 'd54_deep_review_submit',
        arguments: {
          path: temp,
          session: prepData.session,
          findings: [
            {
              category: 'authz',
              file: 'src/auth/login.ts',
              line: 3,
              quote: 'return { allowed: true };',
              title: 'Admin olmayan role izin veriliyor',
              impact: 'Yetkisiz erişim açığı.',
              advice: 'role !== "admin" durumunda allowed: false döndürün.',
              severity: 'critical',
              verdict: 'confirmed',
              reason: 'Koşul ters kurulmuş.',
            },
          ],
          uncertain: 1,
          rejected: 2,
        },
      });
      expect(sub.isError, JSON.stringify(sub.content)).not.toBe(true);
      const subData = sub.structuredContent as {
        accepted: number;
        rejected: { index: number; reason: string }[];
        summary: Report['summary'];
        report_paths: { markdown: string; json: string };
      };
      expect(subData.accepted).toBe(1);
      expect(subData.rejected).toEqual([]);
      expect(subData.summary.counts.critical).toBe(1);
      expect(subData.report_paths.json).toMatch(/\.json$/);
    });

    // CLI deep prepare & deep submit JSON output check
    const cliOut = join(temp, 'cli-reports');
    const { stdout: prepStdout } = await execFileAsync(
      process.execPath,
      [join(repo, 'dist/cli.js'), 'deep', 'prepare', '--path', temp, '--out', cliOut, '--files', '3', '--max-chunks', '10'],
      { cwd: temp },
    );
    const cliPrep = JSON.parse(prepStdout) as { session: string; chunkFiles: string[] };
    expect(cliPrep.session).toMatch(/^[a-f0-9]{16}$/);
    expect(cliPrep.chunkFiles.length).toBeGreaterThanOrEqual(1);

    const findingsFile = join(temp, 'findings.json');
    await writeFile(
      findingsFile,
      JSON.stringify([
        {
          category: 'authz',
          file: 'src/auth/login.ts',
          line: 3,
          quote: 'return { allowed: true };',
          title: 'CLI üzerinden doğrulanan yetki hatası',
          impact: 'Yetkisiz işlem.',
          advice: 'Koşulu düzeltin.',
          severity: 'high',
          verdict: 'confirmed',
          reason: 'Birebir doğrulandı.',
        },
      ]),
    );
    const { stdout: subStdout } = await execFileAsync(
      process.execPath,
      [join(repo, 'dist/cli.js'), 'deep', 'submit', '--path', temp, '--session', cliPrep.session, '--findings', findingsFile, '--out', cliOut],
      { cwd: temp },
    );
    const cliSub = JSON.parse(subStdout) as { accepted: number; report_paths: { json: string; markdown: string } };
    expect(cliSub.accepted).toBe(1);
    expect(cliSub.report_paths.json).toMatch(/\.json$/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 60_000);

it('serves d54_deep_review_run via MCP using configured local loopback provider', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'd54-mcp-deep-run-'));
  let callIndex = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    callIndex++;
    const content = callIndex === 1
      ? JSON.stringify({
          candidates: [
            {
              category: 'authz',
              file: 'src/auth/login.ts',
              line: 3,
              quote: 'return { allowed: true };',
              title: 'Admin olmayan role izin veriliyor',
              impact: 'Yetkisiz erişim açığı.',
              advice: 'role !== "admin" durumunda reddedin.',
            },
          ],
        })
      : JSON.stringify({
          verdict: 'confirmed',
          severity: 'critical',
          reason: 'Doğrudan ters koşul.',
        });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP sunucusu başlatılamadı.');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const client = new Client({ name: 'd54-deep-run-mcp', version: '1.0.0' });

  try {
    await mkdir(join(temp, 'src/auth'), { recursive: true });
    await writeFile(
      join(temp, 'src/auth/login.ts'),
      [
        'export function verifyRole(role: string) {',
        '  if (role !== "admin") {',
        '    return { allowed: true };',
        '  }',
        '  return { allowed: false };',
        '}',
      ].join('\n') + '\n',
    );
    const configPath = join(temp, 'mcp-llm.json');
    await writeFile(
      configPath,
      JSON.stringify({ provider: 'openai-compatible', model: 'mcp-mock-model', base_url: baseUrl }),
    );
    const env = { ...getDefaultEnvironment(), D54_MCP_CONFIG: configPath, NO_COLOR: '1' };
    const transport = new StdioClientTransport({
      command: process.execPath,
      cwd: temp,
      env,
      stderr: 'inherit',
      args: [join(repo, 'dist/mcp-server.js')],
    });
    await client.connect(transport);
    const runRes = await client.callTool({
      name: 'd54_deep_review_run',
      arguments: { path: temp, budget: 4 },
    });
    expect(runRes.isError, JSON.stringify(runRes.content)).not.toBe(true);
    const data = runRes.structuredContent as {
      accepted: number;
      rejected: { index: number; reason: string }[];
      summary: Report['summary'];
      report_paths: { markdown: string; json: string };
      usage: { calls: number; inputTokens: number; outputTokens: number; model: string; confirmed: number };
    };
    expect(data.accepted).toBe(1);
    expect(data.rejected).toEqual([]);
    expect(data.usage).toMatchObject({
      calls: 2,
      inputTokens: 200,
      outputTokens: 100,
      model: 'mcp-mock-model',
      confirmed: 1,
    });
    const saved: Report = JSON.parse(await readFile(data.report_paths.json, 'utf8'));
    expect(saved.findings[0]!.title).toBe('Derin inceleme · Admin olmayan role izin veriliyor');
  } finally {
    try {
      await client.close();
    } finally {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await rm(temp, { recursive: true, force: true });
    }
  }
}, 60_000);

it('rejects budget < 2 and enforces D54_MCP_DEEP_MAX_BUDGET cap with a response note', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'd54-mcp-deep-cap-'));
  let serverCalls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    serverCalls++;
    const content = serverCalls <= 2
      ? JSON.stringify({
          candidates: [
            {
              category: 'logic',
              file: `src/auth/mod${serverCalls}.ts`,
              line: 222,
              quote: 'if (input < 0) return { ok: true };',
              title: `Ters mantık ${serverCalls}`,
              impact: 'Hatalı kabul.',
              advice: 'Koşulu düzeltin.',
            },
          ],
        })
      : JSON.stringify({ verdict: 'confirmed', severity: 'high', reason: 'Doğrulandı.' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 40, completion_tokens: 15 },
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP sunucusu başlatılamadı.');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const client = new Client({ name: 'd54-deep-cap-mcp', version: '1.0.0' });

  try {
    await mkdir(join(temp, 'src/auth'), { recursive: true });
    for (let i = 1; i <= 4; i++) {
      const filler = Array.from({ length: 220 }, (_, k) => `  const check_${i}_${k} = input + ${k};`).join('\n');
      await writeFile(
        join(temp, `src/auth/mod${i}.ts`),
        `export function handler${i}(input: number) {\n${filler}\n  if (input < 0) return { ok: true };\n  return { ok: false };\n}\n`,
      );
    }
    const configPath = join(temp, 'mcp-llm.json');
    await writeFile(
      configPath,
      JSON.stringify({ provider: 'openai-compatible', model: 'mcp-cap-model', base_url: baseUrl }),
    );
    const env = {
      ...getDefaultEnvironment(),
      D54_MCP_CONFIG: configPath,
      D54_MCP_DEEP_MAX_BUDGET: '4',
      NO_COLOR: '1',
    };
    const transport = new StdioClientTransport({
      command: process.execPath,
      cwd: temp,
      env,
      stderr: 'inherit',
      args: [join(repo, 'dist/mcp-server.js')],
    });
    await client.connect(transport);

    const badBudget = await client.callTool({
      name: 'd54_deep_review_run',
      arguments: { path: temp, budget: 1 },
    });
    expect(badBudget.isError).toBe(true);
    expect(serverCalls).toBe(0);

    const capped = await client.callTool({
      name: 'd54_deep_review_run',
      arguments: { path: temp, budget: 20 },
    });
    expect(capped.isError, JSON.stringify(capped.content)).not.toBe(true);
    const data = capped.structuredContent as {
      notes?: string[];
      report_paths: { json: string };
      usage: { calls: number };
    };
    expect(data.usage.calls).toBeLessThanOrEqual(4);
    expect(data.notes?.some(n => n.includes('MCP bütçe tavanı (4)') && n.includes('20'))).toBe(true);
    const saved: Report = JSON.parse(await readFile(data.report_paths.json, 'utf8'));
    expect(saved.coverage.some(c => c.includes('MCP bütçe tavanı (4)'))).toBe(true);
  } finally {
    try {
      await client.close();
    } finally {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await rm(temp, { recursive: true, force: true });
    }
  }
}, 60_000);

it('passes D54_DEEP_CONTEXT_FILE to discovery and verify system prompts in d54_deep_review_run without exposing context path input', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'd54-mcp-deep-ctx-'));
  let callIndex = 0;
  const seenRequests: { system: string; user: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages: { role: string; content: string }[];
    };
    seenRequests.push({
      system: body.messages[0]?.content ?? '',
      user: body.messages[1]?.content ?? '',
    });
    callIndex++;
    const content = callIndex === 1
      ? JSON.stringify({
          candidates: [
            {
              category: 'authz',
              file: 'src/auth/guard.ts',
              line: 2,
              quote: 'return { ok: true };',
              title: 'Üst katman korumalı uç',
              impact: 'Yetkisiz erişim şüphesi.',
              advice: 'Ağ geçidi oturum doğrulamasını kontrol edin.',
            },
          ],
        })
      : JSON.stringify({
          verdict: 'rejected',
          severity: 'low',
          reason: 'Operatör notuna göre üst ağ geçidinde doğrulanıyor.',
        });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 50, completion_tokens: 25 },
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP sunucusu başlatılamadı.');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const client = new Client({ name: 'd54-deep-ctx-mcp', version: '1.0.0' });

  try {
    await mkdir(join(temp, 'src/auth'), { recursive: true });
    await writeFile(
      join(temp, 'src/auth/guard.ts'),
      [
        'export function handleAdminAction() {',
        '  return { ok: true };',
        '}',
      ].join('\n') + '\n',
    );
    const contextFile = join(temp, 'operator-context.txt');
    const contextText = 'MCP-ÜST-KATMAN-KORUMA-NOTU: Tüm /admin yolları ağ geçidinde JWT ile doğrulanır.';
    await writeFile(contextFile, contextText, 'utf8');

    const configPath = join(temp, 'mcp-llm.json');
    await writeFile(
      configPath,
      JSON.stringify({ provider: 'openai-compatible', model: 'mcp-ctx-model', base_url: baseUrl }),
    );
    const env = {
      ...getDefaultEnvironment(),
      D54_MCP_CONFIG: configPath,
      D54_DEEP_CONTEXT_FILE: contextFile,
      NO_COLOR: '1',
    };
    const transport = new StdioClientTransport({
      command: process.execPath,
      cwd: temp,
      env,
      stderr: 'inherit',
      args: [join(repo, 'dist/mcp-server.js')],
    });
    await client.connect(transport);

    const catalog = await client.listTools();
    const runTool = catalog.tools.find(t => t.name === 'd54_deep_review_run');
    expect(runTool).toBeDefined();
    const props = (runTool?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
    expect(props).not.toHaveProperty('context');
    expect(props).not.toHaveProperty('contextFile');

    const runRes = await client.callTool({
      name: 'd54_deep_review_run',
      arguments: { path: temp, budget: 4 },
    });
    expect(runRes.isError, JSON.stringify(runRes.content)).not.toBe(true);
    const data = runRes.structuredContent as {
      accepted: number;
      report_paths: { json: string; markdown: string };
      usage: { calls: number; rejected: number };
    };
    expect(data.accepted).toBe(0);
    expect(data.usage.calls).toBe(2);
    expect(data.usage.rejected).toBe(1);

    expect(seenRequests).toHaveLength(2);
    for (const reqMsg of seenRequests) {
      expect(reqMsg.system).toContain('Operatör mimari notu');
      expect(reqMsg.system).toContain(contextText);
      expect(reqMsg.user).not.toContain('MCP-ÜST-KATMAN-KORUMA-NOTU');
      expect(reqMsg.user).not.toContain('Operatör mimari notu');
    }

    const expectedByteNote = `Operatör bağlam notu kullanıldı (${Buffer.byteLength(contextText, 'utf8')} bayt).`;
    const savedJson = await readFile(data.report_paths.json, 'utf8');
    const savedMd = await readFile(data.report_paths.markdown, 'utf8');
    expect(savedJson).toContain(expectedByteNote);
    expect(savedMd).toContain(expectedByteNote);
    expect(savedJson).not.toContain('MCP-ÜST-KATMAN-KORUMA-NOTU');
    expect(savedMd).not.toContain('MCP-ÜST-KATMAN-KORUMA-NOTU');
  } finally {
    try {
      await client.close();
    } finally {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await rm(temp, { recursive: true, force: true });
    }
  }
}, 60_000);
