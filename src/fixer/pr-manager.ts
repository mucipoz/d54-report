import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { repositoryEnv, safeGitArgs } from '../git-state.js';
import type { Issue } from '../types.js';
import type { changedLines } from './verifier.js';

function git(cwd: string, args: string[], fail = true, input?: string) {
  const result = spawnSync('git', [...safeGitArgs,
    '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', input, timeout: 60_000,
    env: repositoryEnv() });
  if (fail && result.status !== 0) throw new Error(`Git işlemi tamamlanamadı (${args[0]})`);
  return result;
}

export function repository(root: string): string | undefined {
  const res = git(root, ['rev-parse', '--show-toplevel'], false);
  if (res.status === 0) return realpathSync(res.stdout.trimEnd());
}

export function dirty(root: string, out: string): boolean {
  root = repository(root) ?? root;
  const args = ['status', '--porcelain=v1', '--untracked-files=normal', '--', '.'];
  const output = relative(root, out);
  if (output && output !== '..' && !isAbsolute(output) && !output.startsWith('..' + sep)) args.push(`:(exclude,literal)${output}`);
  return git(root, args).stdout.length > 0;
}

export interface AcceptedPatch {
  id: string; file: string; before: string; after: string; diff: string; patch: string;
  edits: ReturnType<typeof changedLines>; issue: Issue;
}
export class PublishUnavailable extends Error {}
export async function draftPullRequest(root: string, patches: AcceptedPatch[],
  verify: (project: string, patch: AcceptedPatch, checkBase: () => void, apply: () => void) => Promise<void>): Promise<string> {
  const repo = repository(root);
  if (!repo) throw new Error('Git deposu bulunamadı');
  const prefix = relative(repo, root);
  if (prefix === '..' || prefix.startsWith('..' + sep) || isAbsolute(prefix)) throw new Error('PR proje yolu depo dışında');
  const base = git(repo, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  const branch = 'd54-fix/' + new Date().toISOString().slice(0, 10) + '-' + patches[0]!.id.toLowerCase() + '-' + randomUUID().slice(0, 8);
  const temp = mkdtempSync(join(tmpdir(), 'd54-pr-')), tree = join(temp, 'checkout');
  let attached = false;
  try {
    git(repo, ['worktree', 'add', '--quiet', '--detach', tree, 'HEAD']);
    attached = true;
    for (const change of patches) {
      const file = join(tree, prefix, change.file);
      // A patch verified against local uncommitted content cannot silently enter a PR against HEAD.
      await verify(join(tree, prefix), change, () => {
        if (realpathSync(file) !== file || readFileSync(file, 'utf8') !== change.before) {
          throw new Error('PR tabanı doğrulanan dosya ile eşleşmiyor');
        }
      }, () => {
        git(tree, ['apply', '--index', '--whitespace=nowarn', ...(prefix ? ['--directory=' + prefix] : []), '-'], true, change.diff);
        if (!readFileSync(file).equals(Buffer.from(change.after))) throw new Error('PR yaması doğrulanan içerikten farklı');
      });
    }
    const identity = git(tree, ['var', 'GIT_AUTHOR_IDENT'], false).status === 0 ? [] :
      ['-c', 'user.name=d54-report', '-c', 'user.email=d54-report@localhost'];
    git(tree, [...identity, 'commit', '--quiet', '-m', 'fix: apply verified d54-report findings']);
    git(tree, ['branch', branch, 'HEAD']);
    const body = `d54-report verified ${patches.length} patch(es) by rescanning each isolated change.`;
    const fallback = `Yerel dal ve commit hazır. git push -u origin ${branch}\nPR açıklaması: ${body}`;
    if (git(repo, ['remote', 'get-url', 'origin'], false).status !== 0 ||
        spawnSync('gh', ['auth', 'status'], { cwd: repo, env: repositoryEnv(), stdio: 'ignore', timeout: 20_000 }).status !== 0) throw new PublishUnavailable(fallback);
    if (git(tree, ['push', '--no-verify', 'origin', 'HEAD:refs/heads/' + branch], false).status !== 0) throw new PublishUnavailable(fallback);
    const pr = spawnSync('gh', ['pr', 'create', '--draft', '--base', base, '--head', branch,
      '--title', 'fix: resolve verified d54-report findings', '--body',
      body],
      { cwd: tree, env: repositoryEnv(), encoding: 'utf8', timeout: 60_000 });
    if (pr.status !== 0) throw new PublishUnavailable(`Dal gönderildi (${branch}), taslak PR açılamadı. PR açıklaması: ${body}`);
    for (const line of (pr.stdout ?? '').trim().split(/\r?\n/)) {
      try {
        const url = new URL(line.trim());
        if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
            /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)) return url.href;
      } catch { /* Other CLI output is not a PR URL. */ }
    }
    throw new PublishUnavailable(`Dal gönderildi (${branch}), taslak PR adresi doğrulanamadı. PR açıklaması: ${body}`);
  } finally {
    if (attached) git(repo, ['worktree', 'remove', '--force', tree], false);
    rmSync(temp, { recursive: true, force: true });
  }
}
