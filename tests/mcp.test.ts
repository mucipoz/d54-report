import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import type { Report } from '../src/types.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const original = '<a href="./page.html" target="_blank">Saat</a>\n';

interface ScanResponse {
  summary: Report['summary'];
  report_paths: { json: string; markdown: string };
  critical_high: unknown[];
  coverage: string[];
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
      args: [join(repo, 'node_modules/vite-node/vite-node.mjs'), '--root', repo, join(repo, 'src/mcp-server.ts')],
    });
    await client.connect(transport);
    const catalog = await client.listTools();
    expect(catalog.tools.map(tool => tool.name).sort()).toEqual(['d54_fix_findings', 'd54_get_report', 'd54_scan_project']);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const scan = await call('d54_scan_project', { path: project, modules: ['security', 'performance'] });
    expect(scan.isError, JSON.stringify(scan.content)).not.toBe(true);
    const scanned = scan.structuredContent as unknown as ScanResponse;
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
    if (!denied.isError) {
      const deniedData = denied.structuredContent as unknown as FixResponse;
      expect(deniedData.results.every(r => r.status !== 'PR_CREATED')).toBe(true);
    }
    await client.ping();
    expect(protocolErrors).toEqual([]);
  } finally {
    try { await client.close(); } finally { await rm(temp, { recursive: true, force: true }); }
  }
}, 60_000);
