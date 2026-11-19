import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const safeGitArgs = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'] as const;

/** Builds a clean git/gh environment isolated from inherited repository override variables. */
export function repositoryEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Explicit cwd selects the checkout, even when called from a hook with its own index.
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GH_REPO']) delete env[key];
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GH_PROMPT_DISABLED: '1' };
}

export interface GitState {
  tracked: Set<string>;
  isIgnored(path: string): Promise<boolean>;
}

/** Reads tracked and ignored file state for a git working tree, or undefined outside git. */
export async function gitState(root: string): Promise<GitState | undefined> {
  try {
    const { stdout } = await execFileAsync('git', [...safeGitArgs, 'ls-files', '-z'], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10_000,
      env: repositoryEnv(),
    });
    const tracked = new Set(stdout.split('\0').filter(Boolean));
    return {
      tracked,
      async isIgnored(path: string): Promise<boolean> {
        try {
          await execFileAsync('git', [...safeGitArgs, 'check-ignore', '-q', '--', path], {
            cwd: root,
            timeout: 10_000,
            env: repositoryEnv(),
          });
          return true;
        } catch {
          return false;
        }
      },
    };
  } catch {
    return undefined;
  }
}
