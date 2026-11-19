import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runScan, verifyRescan, verifySourceRescan } from '../src/engine.js';
import { markdown } from '../src/reporters/markdown.js';
import { snapshot } from '../src/source.js';
import * as ui from '../src/scanners/ui-design.js';
import { categories } from '../src/types.js';
import { previewAsset } from '../src/targets.js';

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

it('4 MiB kaynak sınırına göre 2 MiB .ts okunur, 5 MiB .ts içeriksiz kalır ve not üretir', async () => {
  const dir = join(temp, 'size-limit');
  await mkdir(dir);
  await writeFile(join(dir, 'two-mb.ts'), 'export const x = "' + 'a'.repeat(2 * 1024 * 1024) + '";\n');
  const under = await snapshot(dir);
  expect(under.files.find(f => f.path === 'two-mb.ts')?.text.length).toBeGreaterThan(2 * 1024 * 1024);
  expect(under.notes.some(n => n.includes('Boyut sınırı'))).toBe(false);

  await writeFile(join(dir, 'five-mb.ts'), 'export const y = "' + 'b'.repeat(5 * 1024 * 1024) + '";\n');
  const over = await snapshot(dir);
  expect(over.files.find(f => f.path === 'five-mb.ts')?.text).toBe('');
  expect(over.notes.some(n => n.includes('Boyut sınırı') && n.includes('five-mb.ts'))).toBe(true);
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

it('requires ordinary directories for report output and ordinary public assets for preview', async () => {
  const canonical = await realpath(root);
  const link = join(canonical, 'linked-reports');
  await symlink(out, link, 'dir');
  await expect(runScan({ path: canonical, out: join(link, 'nested'), modules: ['bugs'] })).rejects.toThrow('Rapor dizini');
  await expect(access(join(out, 'nested'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await previewAsset(canonical, '/index.html')).type).toBe('text/html');
  await expect(previewAsset(canonical, '/package.json')).rejects.toThrow();
  await symlink('app.js', join(canonical, 'linked.js'));
  await expect(previewAsset(canonical, '/linked.js')).rejects.toThrow();
  await mkdir(join(canonical, 'assets'));
  await writeFile(join(canonical, 'assets', 'labels.json'), '{}');
  expect((await previewAsset(canonical, '/assets/labels.json')).type).toBe('application/json');
  await expect(previewAsset(canonical, '/assets/labels.json', join(canonical, 'assets'))).rejects.toThrow();
});

it('marks an empty source scan incomplete without reporting an unavailable browser', async () => {
  const empty = join(temp, 'empty');
  await mkdir(empty);
  const scan = await runScan({ path: empty, out, modules: ['bugs'] });
  expect(scan.unavailable).toBe(true);
  expect(scan.browserUnavailable).toBe(false);
  expect(scan.report.coverage.join(' ')).toContain('Kaynak denetimi tamamlanamadı');
});

it('requires the target advisory tool to finish independently of other source checks', async () => {
  const { report } = await runScan({ path: root, out, browser: false, modules: ['security'] });
  const finding = report.findings.find(f => f.rule === 'security.target-blank')!;
  await expect(verifyRescan(root, false, ['security'], finding)).resolves.toEqual(expect.any(Array));
  await expect(verifySourceRescan(root, ['security'], finding)).resolves.toEqual(expect.any(Array));
  const advisory = { ...finding, file: 'package.json', rule: 'security.advisory-npm' };
  await expect(verifyRescan(root, false, ['security'], advisory)).rejects.toThrow('Hedef araca');
  await expect(verifySourceRescan(root, ['security'], advisory)).resolves.toEqual(expect.any(Array));
  await expect(verifySourceRescan(root, ['security'], { ...finding, file: 'missing.html' })).rejects.toThrow('Hedef kaynak');
  const large = join(root,'large.html');
  await writeFile(large,' '.repeat(4 * 1024 * 1024 + 1));
  await expect(verifyRescan(root, false, ['security'], { ...finding, file:'large.html' })).rejects.toThrow('Hedef kaynak');
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
  const { stdout } = await promisify(execFile)(process.execPath, [
    join(repo, 'dist', 'cli.js'), 'scan', '--path', root, '--out', out, '--config', join(temp, 'absent.json'),
    '--no-llm', '--no-browser', '--json',
  ], { cwd: repo, env: { ...process.env, D54_PROVIDER: 'unsupported-fixture-name' }, timeout: 20_000 });
  const report = JSON.parse(stdout);
  expect(report.schemaVersion).toBe(1);
  expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'security.target-blank' })]));
  expect(report.coverage.join(' ')).toContain('AI incelemesi çalışmadı');
});

it.each([['--ids', ','], ['--severity', '']])('rejects an empty %s selection before creating a patch', async (flag, value) => {
  const { prefix, report } = await runScan({ path: root, out, modules: ['security'] });
  expect(report.findings.some(f => f.rule === 'security.target-blank')).toBe(true);
  const original = await readFile(join(root, 'index.html'), 'utf8');
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const run = promisify(execFile)(process.execPath, [
    cli, 'fix', '--path', root, '--out', out, '--report', prefix + '.json', '--mode', 'patch',
    '--no-llm', flag, value,
  ], { cwd: root, timeout: 20_000 });
  await expect(run).rejects.toMatchObject({ code: 1 });
  expect((await readdir(out, { recursive: true })).filter(path => path.endsWith('.patch'))).toEqual([]);
  expect(await readFile(join(root, 'index.html'), 'utf8')).toBe(original);
});

it('warns about unignored output directory only when inside target root using relative path', async () => {
  await promisify(execFile)('git', ['init'], { cwd: root });
  const outsideOut = join(temp, 'outside-reports');
  const outsideRes = await runScan({ path: root, out: outsideOut, browser: false, modules: ['security'] });
  expect(outsideRes.report.coverage.some(c => c.includes('dışlanmıyor'))).toBe(false);

  const customOut = join(root, 'custom-out');
  const unignoredRes = await runScan({ path: root, out: customOut, browser: false, modules: ['security'] });
  expect(unignoredRes.report.coverage).toContain("custom-out/ klasörü git tarafından dışlanmıyor. .gitignore'a 'custom-out/' ekleyin.");

  await writeFile(join(root, '.gitignore'), 'custom-out/\n');
  const ignoredRes = await runScan({ path: root, out: customOut, browser: false, modules: ['security'] });
  expect(ignoredRes.report.coverage.some(c => c.includes('dışlanmıyor'))).toBe(false);
});

it('eyleme dönüştürülen kapsam notlarını coverage içinde raporlar', async () => {
  const emptyBin = await mkdtemp(join(tmpdir(), 'd54-engine-bin-'));
  const prevPath = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    await writeFile(join(root, 'requirements.txt'), 'requests==2.28.0\n');
    await writeFile(join(root, 'huge.js'), Buffer.alloc(4 * 1024 * 1024 + 10, 'x'));
    const scan = await runScan({ path: root, out, browser: false, modules: ['errors', 'security'] });
    expect(scan.report.coverage).toContain('Tip/lint/derleme atlandı. CLI: --trusted; MCP: operatör D54_MCP_TRUSTED_ROOT ayarlar (yalnız incelenmiş proje).');
    expect(scan.report.coverage).toContain('pip-audit bulunamadı. Kurulum: pipx install pip-audit');
    expect(scan.report.coverage.some(c => c.startsWith('Boyut sınırı nedeniyle içeriği okunmayan: huge.js'))).toBe(true);
  } finally {
    process.env.PATH = prevPath;
    await rm(emptyBin, { recursive: true, force: true });
  }
});

it('güvenilir modda güven atlama notu coverage içinde yer almaz', async () => {
  const scan = await runScan({ path: root, out, trusted: true, browser: false, modules: ['errors'] });
  expect(scan.report.coverage.join(' ')).not.toContain('Tip/lint/derleme atlandı');
});

it('triage validates CLI flags and provider before scanning, and attaches triage after makeReport without changing scores', async () => {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const cli = join(repo, 'dist', 'cli.js');
  const freshOut = join(temp, 'triage-no-provider-out');
  const cleanEnv = { ...process.env, D54_PROVIDER: '', D54_MODEL: '', D54_API_KEY: '', D54_BASE_URL: '' };

  await expect(promisify(execFile)(process.execPath, [
    cli, 'scan', '--path', root, '--out', freshOut, '--no-browser', '--triage',
  ], { cwd: temp, env: cleanEnv, timeout: 20_000 })).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('--triage için model yapılandırması gerekir (d54-report.config.json veya D54_PROVIDER/D54_MODEL)'),
  });
  await expect(access(freshOut)).rejects.toThrow();

  await expect(promisify(execFile)(process.execPath, [
    cli, 'scan', '--path', root, '--out', out, '--no-llm', '--no-browser', '--triage',
  ], { cwd: temp, env: cleanEnv, timeout: 20_000 })).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('--triage, --no-llm ile birlikte kullanılamaz.'),
  });
  expect(await readdir(out)).toEqual(['old.json']);

  await writeFile(join(root, 'app.js'), 'eval(userInput);\n');
  const baseline = await runScan({ path: root, out, browser: false, modules: ['security'] });
  const provider = {
    model: 'test-triage-model',
    complete: async () => JSON.stringify({ verdict: 'yanlış alarm', reason: 'Örnek test kodu' }),
  };
  const triaged = await runScan({ path: root, out, browser: false, modules: ['security'], provider, triage: true });
  expect(triaged.report.summary).toEqual(baseline.report.summary);
  expect(triaged.report.priority).toEqual(baseline.report.priority);
  const evalFinding = triaged.report.findings.find(f => f.rule === 'security.dynamic-eval');
  expect(evalFinding?.triage).toEqual({ verdict: 'yanlış alarm', reason: 'Örnek test kodu' });
  expect(triaged.report.coverage.some(c =>
    c.startsWith('Triyaj:') &&
    c.includes('Model: test-triage-model') &&
    c.includes('Bilgi amaçlıdır: bulgu silinmez, puan değişmez; taranan kod modeli yönlendirebilir, kararı doğrulayın.'),
  )).toBe(true);
});
