import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitState } from '../src/git-state.js';

const execFileAsync = promisify(execFile);

describe('gitState güvenlik ve ortam yalıtımı', () => {
  let temp: string;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'd54-git-state-'));
  });

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  it('does not execute core.fsmonitor from untrusted repo config', async () => {
    const repo = join(temp, 'repo');
    const pwned = join(temp, 'PWNED');
    await execFileAsync('git', ['init', repo]);
    await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(repo, 'tracked.txt'), 'hello\n');
    await execFileAsync('git', ['add', '.gitignore', 'tracked.txt'], { cwd: repo });
    await execFileAsync('git', ['config', 'core.fsmonitor', `touch "${pwned}"`], { cwd: repo });

    const state = await gitState(repo);
    expect(state).toBeDefined();
    expect(state?.tracked.has('tracked.txt')).toBe(true);
    expect(await state?.isIgnored('ignored.txt')).toBe(true);
    expect(existsSync(pwned)).toBe(false);
  });

  it('ignores inherited GIT_DIR and GIT_INDEX_FILE overrides', async () => {
    const repo = join(temp, 'repo');
    await execFileAsync('git', ['init', repo]);
    await writeFile(join(repo, 'tracked.txt'), 'hello\n');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repo });

    const prevGitDir = process.env.GIT_DIR;
    const prevGitIndex = process.env.GIT_INDEX_FILE;
    process.env.GIT_DIR = join(temp, 'nonexistent-git-dir');
    process.env.GIT_INDEX_FILE = join(temp, 'nonexistent-index');
    try {
      const state = await gitState(repo);
      expect(state).toBeDefined();
      expect(state?.tracked.has('tracked.txt')).toBe(true);
    } finally {
      if (prevGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prevGitDir;
      if (prevGitIndex === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = prevGitIndex;
    }
  });
});
