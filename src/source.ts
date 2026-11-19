import { readdir, lstat, readFile } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import type { SourceFile } from './types.js';

const ignored = new Set(['.git', '.hg', '.svn', 'node_modules', 'target', 'dist', 'build', '.next', '.nuxt', 'out', 'reports', 'coverage', 'vendor', '.venv', 'venv', '__pycache__', '.cache', '.gradle', '.dart_tool', '.idea']);
const sourceExt = /^(?:\.[cm]?[jt]sx?|\.pyi?|\.rs|\.php|\.html?|\.css|\.scss|\.vue|\.svelte|\.jsonc?|\.toml|\.ya?ml|\.txt|\.ini|\.xml|\.sql|\.lock|\.env|\.pem|\.key)$/i;
const assetExt = /\.(?:png|jpe?g|webp|avif|gif|svg|woff2?|ttf|ico|gltf|glb)$/i;
const lock = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|composer\.lock|poetry\.lock)$/;
export async function snapshot(root: string, excluded?: string) {
  const files: SourceFile[] = [];
  const notes: string[] = [];
  let bytes = 0, skipped = 0, unreadable = 0, visited = 0;
  async function walk(dir: string, bundlesOnly = false): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { unreadable++; return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (++visited > 100_000 || files.length >= 12_000) { skipped++; break; }
      const full = join(dir, entry.name);
      if (full === excluded || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (['dist','build','.next'].includes(entry.name)) await walk(full,true);
        else if (!ignored.has(entry.name)) await walk(full,bundlesOnly);
        continue;
      }
      if (!entry.isFile()) continue;
      const path = relative(root, full).split(sep).join('/');
      const name = basename(path);
      if (!sourceExt.test(extname(name)) && !assetExt.test(name) && !/^\.env(?:\.|$)|^Dockerfile$/.test(name)) continue;
      try {
        const { size } = await lstat(full);
        if (bundlesOnly && (size <= 1_048_576 || !/\.(?:[cm]?js|css|png|jpe?g|svg|glb|gltf|webp)$/i.test(name))) continue;
        const metadataOnly = bundlesOnly || assetExt.test(name) || lock.test(path) || /^\.env(?:$|\.(?!example$|sample$|template$))/.test(name) || /\.(key|pem)$/.test(name);
        const tooLarge = size > 1_048_576 || bytes + size > 48 * 1024 * 1024;
        if (tooLarge && !metadataOnly) skipped++;
        const body = metadataOnly || tooLarge ? '' : await readFile(full, 'utf8');
        bytes += Buffer.byteLength(body);
        files.push({ path, text: body, size });
      } catch { unreadable++; }
    }
  }
  await walk(root);
  if (skipped) notes.push('Dosya, girdi veya bellek sınırına ulaşıldı. Büyük dosyalar yalnız boyut bilgisiyle değerlendirildi. Kapsam kısmi.');
  if (unreadable) notes.push(`${unreadable} dosya/dizin okunamadı.`);
  return { files, notes };
}

export function technology(files: readonly SourceFile[]): string[] {
  const result = new Set<string>();
  for (const f of files) {
    if (/[cm]?tsx?$/.test(extname(f.path))) result.add('TypeScript');
    if (/\.[cm]?jsx?$/.test(f.path) || basename(f.path) === 'package.json') result.add('JavaScript/Node.js');
    if (/\.py$|(?:^|\/)pyproject\.toml$/.test(f.path)) result.add('Python');
    if (/\.rs$|(?:^|\/)Cargo\.toml$/.test(f.path)) result.add('Rust');
    if (/\.php$|(?:^|\/)composer\.json$/.test(f.path)) result.add('PHP');
    if (/tauri\.conf\.|(?:^|\/)src-tauri\//.test(f.path)) result.add('Tauri');
    if (/\.html?$/.test(f.path)) result.add('HTML');
    if (basename(f.path) === 'package.json' && /"three"\s*:/.test(f.text)) result.add('Three.js');
  }
  return [...result].sort();
}
