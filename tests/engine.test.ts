import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runScan } from '../src/engine.js';
import { markdown } from '../src/reporters/markdown.js';
import { snapshot } from '../src/source.js';
import * as ui from '../src/scanners/ui-design.js';
import { categories } from '../src/types.js';

let temp: string, root: string, out: string;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'd54-engine-'));
  root = join(temp, 'site');
  out = join(root, 'local-results');
  await mkdir(join(root, 'node_modules', 'ignored'), { recursive: true });
  await mkdir(out);
  await writeFile(join(root, 'index.html'), '<a target="_blank" href="./index.html">Saat</a>\n');
  await writeFile(join(root, 'app.js'), 'export function readClock() { return Date.now(); }\n');
  await writeFile(join(root, '.env'), 'APP_VALUE=PRIVATE_FIXTURE_MARKER\n');
  await writeFile(join(root, 'node_modules', 'ignored', 'index.html'), '<a href="./" target="_blank">Ignored</a>');
  await writeFile(join(out, 'old.json'), '{}');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: {
    build: 'node -e "require(\'node:fs\').writeFileSync(\'was-run.txt\',\'1\')"',
  } }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(temp, { recursive: true, force: true });
});

it('snapshots only source, excludes reports and withholds environment file contents', async () => {
  const { files } = await snapshot(root, out);
  expect(files.map(f => f.path).sort()).toEqual(['.env', 'app.js', 'index.html', 'package.json']);
  expect(files.find(f => f.path === '.env')).toMatchObject({ text: '' });
  expect(JSON.stringify(files)).not.toContain('PRIVATE_FIXTURE_MARKER');
});

it('writes matching indexed report artifacts, omits untrusted commands and supports a repeat scan', async () => {
  const complete = vi.fn(async () => JSON.stringify({ findings: [] }));
  const { prefix, report } = await runScan({ path: root, out, provider: { complete }, browser: false });
  expect(complete).toHaveBeenCalledOnce();
  expect(report.modules).toEqual(categories);
  expect(dirname(prefix)).toBe(out);
  expect(report.target).toMatchObject({ project: basename(root), root: await realpath(root) });
  expect(report.filesScanned).toBe(4);
  expect(report.stack).toEqual(expect.arrayContaining(['HTML', 'JavaScript/Node.js']));
  expect(report.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ rule: 'security.target-blank', file: 'index.html', line: 1 }),
  ]));
  const md = await readFile(prefix + '.md', 'utf8');
  const persisted = await readFile(prefix + '.json', 'utf8');
  expect(JSON.parse(persisted)).toEqual(JSON.parse(JSON.stringify(report)));
  expect(md).toBe(markdown(report));
  for (const finding of report.findings) expect(md).toContain(finding.id);
  expect(persisted + md).not.toContain('PRIVATE_FIXTURE_MARKER');
  await expect(access(join(root, 'was-run.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  const next = await runScan({ path: root, out, browser: false });
  expect(next.prefix).not.toBe(prefix);
  expect(next.report.findings).toEqual(report.findings);
  expect(next.report.filesScanned).toBe(report.filesScanned);
  expect((await readdir(out)).filter(file => file.startsWith('d54-report-'))).toHaveLength(4);
});

it('rejects ambiguous targets and output set to the source root', async () => {
  await expect(runScan({ path: root, repo: 'https://example.test/unused', out })).rejects.toThrow('--path');
  await expect(runScan({ path: root, out: root })).rejects.toThrow('Rapor dizini');
  await expect(runScan({ url: 'file:///tmp/private.html', out })).rejects.toThrow('HTTP(S)');
});

it('runs only selected source rules, with no browser, provider, audit or build', async () => {
  const complete = vi.fn(async () => JSON.stringify({ findings: [] }));
  const browser = vi.spyOn(ui, 'scanUI');
  await writeFile(join(root, 'sample.ts'), 'const point = 1 / 0;\n');
  const { report, prefix } = await runScan({ path: root, out, trusted: true, provider: { complete }, modules: ['bugs'] });
  expect(report.modules).toEqual(['bugs']);
  expect(JSON.parse(await readFile(prefix + '.json', 'utf8')).modules).toEqual(['bugs']);
  expect(report.findings.map(f => f.rule)).toContain('bugs.zero-divisor');
  expect(report.findings.every(f => f.category === 'bugs')).toBe(true);
  expect(report.priority).toEqual(report.findings.slice(0, 5).map(f => f.id));
  expect(report.summary.total).toBe(report.findings.length);
  expect(report.coverage.join('\n')).not.toMatch(/npm audit|npm build|pip-audit|npm kilit|AI incelemesi/);
  expect(complete).not.toHaveBeenCalled();
  expect(browser).not.toHaveBeenCalled();
  await expect(access(join(root, 'was-run.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('matches shared AST rules and tool planning to their selected categories', async () => {
  await writeFile(join(root, 'calls.js'), 'async function update() { queue.then(store); setInterval(tick, 100); }\n');
  const errors = await runScan({ path: root, out, modules: ['errors'] });
  expect(errors.report.findings.map(f => f.rule)).toContain('errors.promise-rejection');
  expect(errors.report.findings.every(f => f.category === 'errors')).toBe(true);
  expect(errors.report.coverage.join('\n')).not.toContain('npm kilit');
  const perf = await runScan({ path: root, out, modules: ['performance'] });
  expect(perf.report.findings.map(f => f.rule)).toContain('performance.lifecycle-setInterval');
  expect(perf.report.findings.every(f => f.category === 'performance')).toBe(true);
  const security = await runScan({ path: root, out, trusted: true, modules: ['security'] });
  expect(security.report.coverage.join('\n')).toContain('npm kilit');
  await expect(access(join(root, 'was-run.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('filters browser results by category and avoids scanning source on UI-only runs', async () => {
  const issue = { rule: 'ui.fixture', severity: 'low' as const, title: 'UI', evidence: 'one', impact: 'two', advice: 'three' };
  const browser = vi.spyOn(ui, 'scanUI').mockResolvedValue({ issues: [
    { ...issue, category: 'ui' }, { ...issue, category: 'security', rule: 'security.header', title: 'Header' },
  ], notes: [], completed: 1 });
  const { report } = await runScan({ path: root, url: 'http://127.0.0.1:1/', out, modules: ['ui'] });
  expect(browser).toHaveBeenCalledOnce();
  expect(report.findings.map(f => f.category)).toEqual(['ui']);
  expect(report.filesScanned).toBe(0);
  expect(report.summary.health).toBe(99);
  expect(report.priority).toEqual(['UI-001']);
});

it('explains a URL-only source request before launching a browser', async () => {
  const browser = vi.spyOn(ui, 'scanUI');
  await expect(runScan({ url: 'http://127.0.0.1:1/', out, modules: ['errors'] })).rejects.toThrow('--path');
  expect(browser).not.toHaveBeenCalled();
});

it('runs the scan command with JSON output and bypasses provider loading with --no-llm', async () => {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const runner = join(repo, 'node_modules', 'vite-node', 'vite-node.mjs');
  const { stdout } = await promisify(execFile)(process.execPath, [
    runner, 'src/cli.ts', 'scan', '--path', root, '--out', out, '--config', join(temp, 'absent.json'),
    '--no-llm', '--no-browser', '--json',
  ], { cwd: repo, env: { ...process.env, D54_PROVIDER: 'unsupported-fixture-name' }, timeout: 20_000 });
  const report = JSON.parse(stdout);
  expect(report.schemaVersion).toBe(1);
  expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'security.target-blank' })]));
  expect(report.coverage.join(' ')).toContain('AI incelemesi çalışmadı');
});
