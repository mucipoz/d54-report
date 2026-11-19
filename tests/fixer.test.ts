import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runFix, type FixOptions } from '../src/fixer/index.js';
import { deterministicFix } from '../src/fixer/deterministic-fixer.js';
import { llmFix } from '../src/fixer/llm-fixer.js';
import { changedLines, verifyScan } from '../src/fixer/verifier.js';
import { makeReport } from '../src/reporters/json.js';
import type { Issue } from '../src/types.js';

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const original = '<a target="_blank" rel="external" href="/info">Bilgi</a>\n';
const issue: Issue = { file: 'index.html', line: 1, category: 'security', severity: 'low',
  rule: 'security.target-blank', title: 'Bağlantı', evidence: 'Rel koruması eksik', impact: '', advice: '' };

function fixture(): FixOptions {
  const dir = mkdtempSync(join(tmpdir(), 'd54-fixture-'));
  temporary.push(dir);
  const root = join(dir, 'project');
  mkdirSync(root);
  writeFileSync(join(root, 'index.html'), original);
  return { root, out: join(dir, 'reports'), report: makeReport({ project: 'app', root }, [], 1, [issue], []),
    dryRun: false, yes: false, force: false, mode: 'patch',
    rescan: async target => readFileSync(join(target, 'index.html'), 'utf8').includes('noopener') ? [] : [issue] };
}

describe('isolated patch verification', () => {
  it('exports an applicable unified diff from a standalone directory without modifying the original', async () => {
    const o = fixture();
    const [result] = await runFix(o);
    expect(result.status).toBe('PATCH_CREATED');
    expect(result.patchPath).toBe(result.detail);
    expect(result.verification).toEqual([
      { stage: 'git apply --check', status: 'passed' },
      { stage: 'git apply', status: 'passed' },
      { stage: 'rescan', status: 'passed' }
    ]);
    expect(readFileSync(join(o.root, 'index.html'), 'utf8')).toBe(original);
    expect(spawnSync('git', ['apply', '--check', result.detail!], { cwd: o.root }).status).toBe(0);
    expect(readFileSync(result.detail!, 'utf8')).toContain('rel="external noopener noreferrer"');
  });

  it('rolls back a candidate when the next scan finds a regression', async () => {
    const o = fixture();
    const base = o.rescan;
    o.rescan = async dir => (await base(dir)).length ? [issue] : [{ ...issue, rule: 'regression' }];
    const [result] = await runFix(o);
    expect(result.status).toBe('FIX_FAILED (Rollback)');
    expect(result.patchPath).toBeUndefined();
    expect(result.verification).toContainEqual(expect.objectContaining({ stage: 'rescan', status: 'failed' }));
    expect(readFileSync(join(o.root, 'index.html'), 'utf8')).toBe(original);
    expect(existsSync(o.out)).toBe(false);
  });

  it('tracks identical findings to the requested line across a patch that inserts a line', () => {
    const target = {...issue, line: 2}, duplicate = {...issue, line: 3};
    const edits = changedLines('@@ -1,3 +1,4 @@\n heading\n+note\n-first\n+renamed\n second\n');
    const baseline = [target, duplicate];
    // The original first occurrence still appears at line 3 after insertion.
    expect(() => verifyScan(baseline, [{...target, line: 3}], target, 'index.html', edits)).toThrow('hedef');
    expect(() => verifyScan(baseline, [{...duplicate, line: 4}], target, 'index.html', edits)).not.toThrow();
    expect(() => verifyScan(baseline, [{...duplicate, line: 7}], target, 'index.html', edits)).toThrow('Yeni bulgu');
  });

  it('rolls back when the rescan cannot complete the specific finding check', async () => {
    const o = fixture();
    const requested: Issue[] = [];
    o.rescan = async (_dir, target) => {
      if (!target) return [issue];
      requested.push(target);
      throw new Error('Hedef denetim tamamlanamadı');
    };
    const [result] = await runFix(o);
    expect(requested).toEqual([issue]);
    expect(result.status).toBe('FIX_FAILED (Rollback)');
    expect(result.verification).toContainEqual(expect.objectContaining({stage:'rescan',status:'failed'}));
    expect(result.patchPath).toBeUndefined();
    expect(readFileSync(join(o.root, 'index.html'), 'utf8')).toBe(original);
  });

  it('requests PR consent only for exported verified patches and preserves them on denial', async () => {
    const o = fixture();
    const approvals: string[][] = [];
    const [result] = await runFix({ ...o, mode: 'pr', approvePR: async patches => {
      approvals.push(patches.map(p => p.id));
      expect(patches).toHaveLength(1);
      expect(patches[0].file).toBe('index.html');
      expect(readFileSync(patches[0].patchPath, 'utf8')).toContain('noopener');
      return false;
    } });
    expect(approvals).toEqual([[result.id]]);
    expect(result.status).toBe('PATCH_CREATED');
    expect(result.verification).toContainEqual(expect.objectContaining({stage: 'pr.verify', status: 'skipped'}));
    expect(readFileSync(join(o.root, 'index.html'), 'utf8')).toBe(original);
  });

  it('keeps an unreviewed model patch out of trusted checks, later baselines and the PR approval list', async () => {
    const o = fixture(), file = 'setting.ts';
    const modelIssue: Issue = {...issue, file, severity:'high', rule:'bugs.example', title:'Flag', evidence:'true'};
    const source = 'const setting = true;\n';
    writeFileSync(join(o.root,file), source);
    writeFileSync(join(o.root,'package.json'), JSON.stringify({scripts:{test:'exit 0'}}));
    o.report = makeReport({project:'app',root:o.root}, [], 2, [modelIssue,issue], []);
    const trustedSources: string[] = [], staticSources: string[] = [], approved: string[] = [];
    const scan = async (dir:string, seen:string[]) => {
      const body = readFileSync(join(dir,file),'utf8');
      seen.push(body);
      return [...(body.includes('true') ? [modelIssue] : []), ...await fixtureScan(dir)];
    };
    const fixtureScan = o.rescan;
    const results = await runFix({...o,mode:'pr',trusted:true,allowCandidatePrompt:false,
      provider:{async complete(_system,input) {
        const line = JSON.parse(input).source.trimEnd() as string;
        return ['--- a/source','+++ b/source','@@ -1 +1 @@','-'+line,'+'+line.replace('true','false')].join('\n');
      }}, rescan:dir=>scan(dir,trustedSources), sourceRescan:dir=>scan(dir,staticSources),
      approvePR:async patches=>{approved.push(...patches.map(p=>p.file));return false;}});
    const result = results.find(r=>r.id===o.report.findings.find(f=>f.file===file)!.id)!;
    expect(result.status).toBe('PATCH_UNVERIFIED');
    expect(existsSync(result.patchPath!)).toBe(true);
    expect(result.verification).toEqual(expect.arrayContaining([
      {stage:'source.rescan',status:'passed'}, expect.objectContaining({stage:'test',status:'skipped'}),
      expect.objectContaining({stage:'candidate.approval',status:'skipped'}),expect.objectContaining({stage:'rescan',status:'skipped'})
    ]));
    expect(staticSources).toEqual([source,source.replace('true','false')]);
    expect(trustedSources.length).toBeGreaterThan(1);
    expect(trustedSources.every(s=>s===source)).toBe(true);
    expect(approved).toEqual(['index.html']);
    expect(readFileSync(join(o.root,file),'utf8')).toBe(source);
  });

  it('exports unverified patches when local test execution has not been authorized', async () => {
    const o = fixture();
    writeFileSync(join(o.root, 'package.json'), JSON.stringify({ scripts: { test: 'exit 7' } }));
    const [result] = await runFix({ ...o, mode: 'interactive', yes: true });
    expect(result.status).toBe('PATCH_UNVERIFIED');
    expect(existsSync(result.patchPath!)).toBe(true);
    expect(result.verification).toContainEqual(expect.objectContaining({ stage: 'test', status: 'skipped' }));
    expect(result.verification).toContainEqual({ stage: 'rescan', status: 'passed' });
    expect(readFileSync(join(o.root, 'index.html'), 'utf8')).toBe(original);
  });

  it('reports a failed verification command and preserves the source file', async () => {
    const o = fixture();
    writeFileSync(join(o.root, 'package.json'), JSON.stringify({ scripts: { test: 'exit 7' } }));
    const [result] = await runFix({ ...o, trusted: true });
    expect(result.status).toBe('FIX_FAILED (Rollback)');
    expect(result.detail).toContain('test');
    expect(result.verification).toContainEqual(expect.objectContaining({ stage: 'test', status: 'failed' }));
    expect(result.verification).toContainEqual(expect.objectContaining({ stage: 'rescan', status: 'skipped' }));
    expect(readFileSync(join(o.root, 'index.html'), 'utf8')).toBe(original);
  });

  it('records only executed checks and excludes raw command output from stage details', async () => {
    const o = fixture();
    writeFileSync(join(o.root, 'package.json'), JSON.stringify({ scripts: {
      build: 'exit 0', typecheck: 'echo private-diagnostic-value >&2 && exit 7', test: 'exit 0'
    } }));
    const [result] = await runFix({ ...o, trusted: true });
    expect(result.verification?.map(({stage, status}) => [stage, status])).toEqual([
      ['git apply --check', 'passed'], ['git apply', 'passed'], ['build', 'passed'],
      ['typecheck', 'failed'], ['test', 'skipped'], ['rescan', 'skipped']
    ]);
    expect(JSON.stringify(result.verification)).not.toContain('private-diagnostic-value');
    expect(result.patchPath).toBeUndefined();
  });

  it('creates a verified local PR branch without touching the user branch, index or unrelated edits', async () => {
    const o = fixture();
    const git = (...args: string[]) => {
      const command = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
        '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args], { cwd: o.root, encoding: 'utf8' });
      expect(command.status).toBe(0);
      return command.stdout.trim();
    };
    git('init', '--quiet');
    git('add', 'index.html');
    git('commit', '-qm', 'fixture');
    writeFileSync(join(o.root, 'unrelated.txt'), 'local');
    const initial = git('rev-parse', 'HEAD');
    const [result] = await runFix({ ...o, mode: 'pr', yes: true, force: true });
    expect(result.status).toBe('PR_FALLBACK');
    expect(existsSync(result.patchPath!)).toBe(true);
    expect(result.verification).toEqual(expect.arrayContaining([
      { stage: 'pr.verify', status: 'passed' }, { stage: 'pr.baseline', status: 'passed' },
      { stage: 'pr.git apply --index', status: 'passed' }, { stage: 'pr.rescan', status: 'passed' }
    ]));
    const branch = result.detail?.match(/git push -u origin (d54-fix\/[^\s]+)/)?.[1];
    expect(branch).toBeTruthy();
    expect(git('show', branch + ':index.html')).toContain('noopener noreferrer');
    expect(git('rev-parse', 'HEAD')).toBe(initial);
    expect(git('status', '--porcelain')).toBe('?? unrelated.txt');
    expect(readFileSync(join(o.root, 'index.html'), 'utf8')).toBe(original);
  });

  it('declines symlink targets and filters findings', async () => {
    const o = fixture(), path = join(o.root, 'index.html');
    expect(await runFix({ ...o, ids: ['SEC-999'] })).toEqual([]);
    rmSync(path);
    writeFileSync(join(o.root, 'other.html'), original);
    symlinkSync('other.html', path);
    // The snapshot deliberately omits links.
    o.rescan = async () => [issue];
    expect((await runFix(o))[0].status).toBe('FIX_FAILED (Rollback)');
    expect(readFileSync(join(o.root, 'other.html'), 'utf8')).toBe(original);
  });
});

it('keeps an existing rel and ignores attributes nested inside another attribute', () => {
  expect(deterministicFix(original, issue)).toContain('rel="external noopener noreferrer"');
  expect(deterministicFix('<a title=\' target="_blank"\'>Hi</a>', issue)).toBeUndefined();
});

it('masks identifiers and literals for the provider and rejects a second file header', async () => {
  let sent = '';
  const provider = { async complete(_: string, input: string) {
    sent = input;
    return '--- a/source\n+++ b/other\n@@ -1 +1 @@\n-x\n+y';
  } };
  await expect(llmFix(provider, 'const privateLabel = "privateValue";\n', { ...issue, file: 'a.ts' }))
    .rejects.toThrow('hedefi');
  expect(sent).not.toContain('privateLabel');
  expect(sent).not.toContain('privateValue');
});
