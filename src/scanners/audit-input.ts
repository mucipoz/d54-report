import { constants } from 'node:fs';
import { open, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const semver = /^v?\d+(?:\.\d+){1,3}(?:[-+][a-zA-Z0-9.+-]+)?$/;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const safeName = (value: string) => value.length <= 214 && packageName.test(value)
  && !['constructor', 'prototype', '__proto__', 'node_modules'].includes(value);

async function input(root: string, file: string, name: string): Promise<string> {
  const path = resolve(root, dirname(file), name);
  if (await realpath(path) !== path || relative(root, path).split(sep)[0] === '..') throw Error();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw Error();
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw Error();
      offset += bytesRead;
    }
    return buffer.toString('utf8');
  } finally { await handle.close(); }
}

type Entry = { version: string; name?: string; dependencies?: Record<string, string> };

function npmInput(source: string): Record<string, string> {
  const original = JSON.parse(source);
  if (![2, 3].includes(original.lockfileVersion) || !original.packages || !Object.hasOwn(original.packages, '')) throw Error();
  const manifest: Entry = { name: 'd54-audit-input', version: '1.0.0' };
  const packages: Record<string, Entry> = Object.create(null);
  packages[''] = manifest;
  const edges: [string, string, string][] = [];
  for (const [path, item] of Object.entries(original.packages)) {
    if (!path) continue;
    const entry = item as { version?: string; resolved?: string; link?: boolean; name?: string };
    const segments = path.split(/(?:^|\/)node_modules\//);
    const name = segments.pop()!;
    if (!path.startsWith('node_modules/') || !safeName(name) || segments.slice(1).some(s => !safeName(s))
        || !entry || entry.link || typeof entry.version !== 'string' || !semver.test(entry.version)
        || (entry.resolved !== undefined && (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/')))
        || (entry.name !== undefined && entry.name !== name)) throw Error();
    const parent = segments.join('/node_modules/').replace(/^\//, '');
    packages[path] = { version: entry.version };
    edges.push([parent, name, entry.version]);
  }
  for (const [parent, name, version] of edges) {
    if (!packages[parent]) throw Error();
    (packages[parent]!.dependencies ??= Object.create(null))[name] = version;
  }
  return { 'package.json': JSON.stringify(manifest),
    'package-lock.json': JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages }) };
}

function cargoInput(source: string): Record<string, string> {
  const records = source.split(/^\[\[package\]\]\s*$/m).slice(1);
  if (!records.length && !/^version\s*=\s*[34]\s*$/m.test(source)) throw Error();
  const entries: string[] = ['version = 3'];
  for (const record of records) {
    const location = record.match(/^source\s*=\s*"([^"\n]+)"\s*$/m)?.[1];
    if (!location) continue; // Yerel çalışma alanı paketi kayıt hizmetinden gelmez.
    if (location !== 'registry+https://github.com/rust-lang/crates.io-index' && location !== 'sparse+https://index.crates.io/') throw Error();
    const name = record.match(/^name\s*=\s*"([a-zA-Z0-9_-]+)"\s*$/m)?.[1];
    const version = record.match(/^version\s*=\s*"([^"\n]+)"\s*$/m)?.[1];
    if (!name || name.length > 128 || !version || !semver.test(version)) throw Error();
    entries.push('[[package]]\nname = "' + name + '"\nversion = "' + version + '"\nsource = "registry+https://github.com/rust-lang/crates.io-index"');
  }
  return { 'Cargo.lock': entries.join('\n\n') + '\n' };
}

function composerInput(source: string): Record<string, string> {
  const original = JSON.parse(source);
  if (!Array.isArray(original.packages)) throw Error();
  const clean = (packages: { name?: unknown; version?: unknown }[]) => packages.map(item => {
    if (typeof item?.name !== 'string' || !/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(item.name)
        || typeof item.version !== 'string' || !semver.test(item.version)) throw Error();
    return { name: item.name, version: item.version, type: 'library' };
  });
  return { 'composer.json': JSON.stringify({ name: 'd54/audit-input', require: {} }),
    'composer.lock': JSON.stringify({ packages: clean(original.packages), 'packages-dev': clean(original['packages-dev'] ?? []),
      aliases: [], 'stability-flags': {}, 'minimum-stability': 'stable', 'prefer-stable': false, 'prefer-lowest': false,
      platform: {}, 'platform-dev': {}, 'plugin-api-version': '2.0.0' }) };
}

function pipInput(source: string): Record<string, string> {
  const pinned: string[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/(?:^|\s)#.*$/, '').trim();
    if (!line) continue;
    if (!/^[a-z0-9][a-z0-9._-]{0,127}==[0-9][a-z0-9.+!-]{0,95}$/i.test(line)) throw Error();
    pinned.push(line);
  }
  return { 'requirements.txt': pinned.join('\n') + '\n' };
}

export async function prepareAudit(root: string, file: string, kind: 'npm' | 'cargo' | 'pip' | 'composer',
  cwd: string, snapshot: ReadonlySet<string>): Promise<void> {
  const name = kind === 'cargo' ? 'Cargo.lock' : kind === 'pip' ? 'requirements.txt' : kind === 'composer' ? 'composer.lock'
    : snapshot.has(join(dirname(file), 'npm-shrinkwrap.json').split(sep).join('/')) ? 'npm-shrinkwrap.json' : 'package-lock.json';
  const source = await input(root, file, name);
  const clean = { npm: npmInput, cargo: cargoInput, pip: pipInput, composer: composerInput }[kind](source);
  for (const [filename, content] of Object.entries(clean)) await writeFile(join(cwd, filename), content, { flag: 'wx', mode: 0o600 });
}
