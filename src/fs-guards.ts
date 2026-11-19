import { constants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export function hostToolPath(project: string, command: string): string {
  const root = resolve(project);
  const dirs: string[] = [];
  const outsideProject = (path: string) => {
    const rel = relative(root, path);
    return isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep);
  };
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    try {
      const path = realpathSync(entry);
      if (!outsideProject(path) || path.split(sep).includes('node_modules')) continue;
      try { if (!outsideProject(realpathSync(join(path,command)))) continue; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') continue; }
      dirs.push(path);
    } catch { /* PATH may include obsolete entries. */ }
  }
  // An empty PATH component implicitly searches the process working directory.
  return dirs.length ? dirs.join(delimiter) : join(process.execPath,'no-directory');
}

export async function ensureOutputDirectory(dir: string): Promise<void> {
  const absolute = resolve(dir);
  let current = parse(absolute).root;
  if (absolute === current) throw Error('Dosya sistemi kökü rapor dizini olarak kullanılamaz.');
  for (const part of relative(current, absolute).split(sep)) {
    if (part.toLowerCase() === '.git') throw Error('Git veritabanına rapor yazılamaz.');
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    if (!(await lstat(current)).isDirectory()) throw Error('Rapor dizini yolu sembolik bağlantı veya dosya içeriyor.');
  }
}

export async function readBoundedFile(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit || await realpath(path) !== path) throw Error('Dosya türü, yolu veya boyutu desteklenmiyor.');
    const data = Buffer.alloc(info.size);
    for (let offset = 0; offset < data.length;) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw Error('Okuma sırasında dosya değişti.');
      offset += bytesRead;
    }
    return data;
  } finally { await handle.close(); }
}
