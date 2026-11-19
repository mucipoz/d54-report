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
    expect(catalog.tools.map(tool => tool.name).sort()).toEqual(['d54_fix_findings', 'd54_get_report', 'd54_scan_project']);
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
