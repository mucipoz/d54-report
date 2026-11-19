import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitState {
  tracked: Set<string>;
  isIgnored(path: string): Promise<boolean>;
}

/** Reads tracked and ignored file state for a git working tree, or undefined outside git. */
export async function gitState(root: string): Promise<GitState | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    });
    const tracked = new Set(stdout.split('\0').filter(Boolean));
    return {
      tracked,
      async isIgnored(path: string): Promise<boolean> {
        try {
          await execFileAsync('git', ['check-ignore', '-q', '--', path], { cwd: root });
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
