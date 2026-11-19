import { writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { readBoundedFile } from '../fs-guards.js';
import { parse as parseToml } from 'smol-toml';

const semver = /^v?\d+(?:\.\d+){1,3}(?:[-+][a-zA-Z0-9.+-]+)?$/;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const safeName = (value: string) => value.length <= 214 && packageName.test(value)
  && !['constructor', 'prototype', '__proto__', 'node_modules'].includes(value);

async function input(root: string, file: string, name: string): Promise<string> {
  const path = resolve(root, dirname(file), name);
  if (relative(root, path).split(sep)[0] === '..') throw Error();
  return (await readBoundedFile(path, 8 * 1024 * 1024)).toString('utf8');
}

type Entry = { version: string; name?: string; dependencies?: Record<string, string> };

function npmInput(source: string): { files: Record<string, string>; skipped: number } {
  const original = JSON.parse(source);
  if (![2, 3].includes(original.lockfileVersion) || !original.packages || typeof original.packages !== 'object'
      || Array.isArray(original.packages) || !Object.hasOwn(original.packages, '')) throw Error();
  const manifest: Entry = { name: 'd54-audit-input', version: '1.0.0' };
  const packages: Record<string, Entry> = Object.create(null);
  packages[''] = manifest;
  const edges: [string, string, string][] = [];
  const remap = new Map<string, string>();
  const wsParents = new Map<string, string>();
  let wsCounter = 0;
  let skipped = 0;

  const entries = Object.entries(original.packages)
    .filter(([path]) => Boolean(path))
    .map(([path, item]) => {
      const nmIdx = path.startsWith('node_modules/') ? 0 : path.indexOf('/node_modules/');
      return { path, item, nmIdx, depth: nmIdx < 0 ? -1 : path.slice(nmIdx).split(/(?:^|\/)node_modules\//).length };
    })
    .sort((a, b) => a.depth - b.depth);

  for (const { path, item, nmIdx } of entries) {
    if (nmIdx < 0) continue;
    const entry = item as { version?: string; resolved?: string; link?: boolean; name?: string };
    if (!entry || typeof entry !== 'object') { skipped++; continue; }
    if (entry.link) continue;

    const ws = nmIdx === 0 ? '' : path.slice(0, nmIdx);
    const rest = nmIdx === 0 ? path : path.slice(nmIdx + 1);
    const segments = rest.split(/(?:^|\/)node_modules\//);
    const name = segments.pop()!;

    if (!safeName(name) || segments.slice(1).some(s => !safeName(s))
        || typeof entry.version !== 'string' || !semver.test(entry.version)) {
      skipped++;
      continue;
    }
    if (entry.resolved !== undefined && (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/'))) {
      skipped++;
      continue;
    }
    if (entry.name !== undefined && (typeof entry.name !== 'string' || !safeName(entry.name))) {
      skipped++;
      continue;
    }

    const origParentRest = segments.join('/node_modules/').replace(/^\//, '');
    const origParent = ws ? (origParentRest ? `${ws}/${origParentRest}` : ws) : origParentRest;

    let targetParent = '';
    let targetPath = '';
    if (!origParent || origParent === ws) {
      if (!packages[rest]) {
        targetParent = '';
        targetPath = rest;
      } else {
        let wsParent = wsParents.get(ws);
        if (!wsParent) {
          const wsKey = 'd54-ws-' + (++wsCounter);
          wsParent = 'node_modules/' + wsKey;
          packages[wsParent] = { version: '0.0.0' };
          edges.push(['', wsKey, '0.0.0']);
          wsParents.set(ws, wsParent);
        }
        targetParent = wsParent;
        targetPath = wsParent + '/' + rest;
      }
    } else {
      const mappedParent = remap.get(origParent);
      if (!mappedParent || !packages[mappedParent]) {
        skipped++;
        continue;
      }
      targetParent = mappedParent;
      targetPath = mappedParent + '/node_modules/' + name;
    }

    if (packages[targetPath]) {
      skipped++;
      continue;
    }

    const outEntry: Entry = { version: entry.version };
    if (entry.name !== undefined && entry.name !== name) outEntry.name = entry.name;
    packages[targetPath] = outEntry;
    remap.set(path, targetPath);
    edges.push([targetParent, name, entry.version]);
  }

  for (const [parent, name, version] of edges) {
    if (!packages[parent]) continue;
    (packages[parent]!.dependencies ??= Object.create(null))[name] = version;
  }
  return {
    skipped,
    files: {
      'package.json': JSON.stringify(manifest),
      'package-lock.json': JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages }),
    },
  };
}

function cargoInput(source: string): Record<string, string> {
  const lock = parseToml(source);
  const records = lock.package;
  if (!Array.isArray(records) || !records.length) throw Error();
  const entries: string[] = ['version = 3'];
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw Error();
    const { source: location, name, version } = record as Record<string, unknown>;
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(name)
        || typeof version !== 'string' || !semver.test(version)) throw Error();
    if (location === undefined) continue; // Yerel çalışma alanı paketi kayıt hizmetinden gelmez.
    if (location !== 'registry+https://github.com/rust-lang/crates.io-index' && location !== 'sparse+https://index.crates.io/') throw Error();
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
  cwd: string, snapshot: ReadonlySet<string>): Promise<{ skipped: number }> {
  const name = kind === 'cargo' ? 'Cargo.lock' : kind === 'pip' ? 'requirements.txt' : kind === 'composer' ? 'composer.lock'
    : snapshot.has(join(dirname(file), 'npm-shrinkwrap.json').split(sep).join('/')) ? 'npm-shrinkwrap.json' : 'package-lock.json';
  const source = await input(root, file, name);
  const result = kind === 'npm' ? npmInput(source)
    : { files: { cargo: cargoInput, pip: pipInput, composer: composerInput }[kind](source), skipped: 0 };
  for (const [filename, content] of Object.entries(result.files)) await writeFile(join(cwd, filename), content, { flag: 'wx', mode: 0o600 });
  return { skipped: result.skipped };
}
