import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensureOutputDirectory } from '../fs-guards.js';
import type { Report } from '../types.js';
import { json } from './json.js';
import { markdown } from './markdown.js';

export async function writeReport(out: string, report: Report): Promise<string> {
  const dir = resolve(out);
  const slug = (report.target.project.replace(/[^a-z0-9_-]+/gi, '-') || 'project').slice(0, 64);
  const prefix = resolve(dir, `d54-report-${slug}-${report.createdAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await ensureOutputDirectory(dir);
  await writeFile(prefix + '.md', markdown(report), { flag: 'wx', mode: 0o600 });
  try {
    await writeFile(prefix + '.json', json(report), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rm(prefix + '.md', { force: true });
    throw error;
  }
  return prefix;
}
