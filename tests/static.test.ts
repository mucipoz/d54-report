import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SourceFile } from '../src/types.js';
import { scan as errors } from '../src/scanners/errors.js';
import { scan as security } from '../src/scanners/security.js';
import { scan as performance } from '../src/scanners/performance.js';
import { scan as bugs } from '../src/scanners/bugs.js';
import { scan as specialized } from '../src/scanners/specialized.js';
import { prepareAudit } from '../src/scanners/audit-input.js';
import { scanTools } from '../src/scanners/tooling.js';
import { snapshot } from '../src/source.js';

function source(path: string, text: string): SourceFile {
  return { path, text, size: Buffer.byteLength(text) };
}

describe('statik kaynak kuralları', () => {
  it('çözümlenemeyen içe aktarımı ve boş catch konumunu bildirir', () => {
    const file = source('src/a.ts', "import './b.js';\nimport './missing.js';\ntry {} catch {}");
    const issues = errors(file, [file, source('src/b.ts', 'export {};')]);
    expect(issues.map(i => [i.rule, i.line])).toEqual(expect.arrayContaining([
      ['errors.missing-import', 2], ['errors.empty-catch', 3],
    ]));
    expect(issues).toHaveLength(2);
  });

  it('sözdizimi hatasını raporlar ve yalnız metadata içeren kilit dosyasını atlar', () => {
    const bad = source('a.ts', 'let x = ;');
    expect(errors(bad, [bad]).some(i => i.rule === 'errors.syntax')).toBe(true);
    expect(errors({ path: 'package-lock.json', size: 220, text: '' }, [])).toEqual([]);
  });

  it('gizli ayar değerini rapora eklemez', () => {
    const literal = ['fixture', 'value'].reverse().join('-');
    const file = source('config.ts', 'const apiKey = "' + literal + '";');
    const issues = security(file, [file]);
    expect(issues).toContainEqual(expect.objectContaining({ rule: 'security.literal-secret', line: 1 }));
    expect(JSON.stringify(issues)).not.toContain(literal);
  });

  it('yorumları ve korumalı bağlantıları atlar', () => {
    const file = source('index.html', '<!-- <a target="_blank"> -->\n<a target="_blank" rel="noopener">ok</a>\n<a title=\' target="_blank"\'>ok</a>\n<a target="_blank">a</a>');
    expect(security(file, [file]).map(i => [i.rule, i.line])).toEqual([['security.target-blank', 4]]);
  });

  it('döngüde bekleme ve async forEach kullanımını saptar', () => {
    const file = source('example.ts', 'async function go() { for (const x of xs) { await work(x); } }\nxs.forEach(async x => work(x));');
    expect(performance(file, [file]).map(i => i.rule)).toContain('performance.await-loop');
    expect(bugs(file, [file]).map(i => i.rule)).toContain('bugs.async-foreach');
  });

  it('Three.js, Rust ve Tauri yaşam döngüsü ve izin işaretlerini ayırır', () => {
    const three = source('scene.ts', 'const r = new THREE.WebGLRenderer(); requestAnimationFrame(draw);');
    expect(specialized(three, [three]).map(i => i.rule).sort()).toEqual([
      'specialized.three-animation', 'specialized.three-context', 'specialized.three-disposal',
    ]);
    const rust = source('src/lib.rs', 'fn parse() { let _x = result.unwrap(); }');
    expect(specialized(rust, [rust])[0]?.rule).toBe('specialized.rust-panic');
    const tauri = source('capabilities/main.json', '{"permissions":["shell:allow-execute"]}');
    expect(specialized(tauri, [tauri])[0]?.rule).toBe('specialized.tauri-permissions');
  });

  it('bir kaynağın dispose çağrısını başka bir kaynağa saymaz ve animasyon tahsisini bulur', () => {
    const file = source('scene.ts', [
      'const geo = new THREE.BoxGeometry();', 'const mat = new THREE.MeshBasicMaterial();',
      'geo.dispose();', 'function frame() { const point = new THREE.Vector3(); }', 'requestAnimationFrame(frame);',
    ].join('\n'));
    const issues = specialized(file, [file]);
    expect(issues.filter(i => i.rule === 'specialized.three-disposal').map(i => i.line)).toEqual([2]);
    expect(issues.find(i => i.rule === 'specialized.three-frame-allocation')?.line).toBe(4);
  });

  it('Rust test modülünü ve SAFETY ile açıklanmış sınırı atlar', () => {
    const file = source('src/lib.rs', [
      '#[cfg(test)]', 'mod checks {', ' fn trial() { result.unwrap(); }', '}',
      '// SAFETY: sözleşme çağrıdan önce denetlenir.', 'unsafe { call(); }', 'unsafe { call(); }',
    ].join('\n'));
    expect(specialized(file, [file]).map(i => i.line)).toEqual([7]);
  });

  it('Tauri dosya kapsamındaki özyinelemeli joker iznini algılar', () => {
    const file = source('capabilities/main.json', JSON.stringify({ permissions: [{ identifier: 'fs:scope', allow: [{ path: '$HOME/**' }] }] }));
    expect(specialized(file, [file])[0]?.rule).toBe('specialized.tauri-permissions');
  });
});

describe('araç girdileri', () => {
  it('Cargo girdisi geçerli bir paket listesi olmadan temiz denetim girdisine dönüşmez', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'd54-lock-'));
    try {
      const output = join(dir, 'input');
      await mkdir(output);
      await writeFile(join(dir, 'Cargo.lock'), 'version = 4\n[[package]]\nname = "a"\nversion =\n');
      await expect(prepareAudit(dir, 'Cargo.toml', 'cargo', output, new Set(['Cargo.lock']))).rejects.toThrow();
      await expect(readFile(join(output, 'Cargo.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('varsayılan modda proje derleme betiğini atlar ve yönlendirici not üretir', async () => {
    const file = source('package.json', '{"scripts":{"build":"fixture-build"}}');
    const result = await scanTools(tmpdir(), [file], false);
    expect(result.issues).toEqual([]);
    expect(result.notes).toContain('Tip/lint/derleme atlandı. CLI: --trusted; MCP: operatör D54_MCP_TRUSTED_ROOT ayarlar (yalnız incelenmiş proje).');
  });

  it('npm kilidinden yalnız adlar, sürümler ve bağımlılık ilişkilerini üretir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'd54-fixture-'));
    const out = join(root, 'out');
    try {
      await mkdir(out);
      await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
        '': { scripts: { build: 'fixture-build' } }, 'node_modules/a': { version: '1.2.0', custom: 'unrelated-metadata' },
        'node_modules/a/node_modules/b': { version: '2.0.1' },
      } }));
      await prepareAudit(root, 'package.json', 'npm', out, new Set(['package-lock.json']));
      const sanitized = await readFile(join(out, 'package-lock.json'), 'utf8');
      expect(sanitized).not.toContain('unrelated-metadata');
      expect(sanitized).not.toContain('fixture-build');
      expect(JSON.parse(sanitized).packages['node_modules/a'].dependencies.b).toBe('2.0.1');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('workspace lock produces audit input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'd54-ws-'));
    const out = join(root, 'out');
    try {
      await mkdir(out);
      await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
        '': { name: 'mono', version: '1.0.0' },
        'apps/web': { name: '@mono/web', version: '1.0.0' },
        'node_modules/@mono/web': { resolved: 'apps/web', link: true },
        'apps/web/node_modules/zod': { version: '3.22.4', resolved: 'https://registry.npmjs.org/zod/-/zod-3.22.4.tgz' },
        'packages/ui': { name: '@mono/ui', version: '1.0.0' },
        'packages/ui/node_modules/zod': { version: '3.21.4', resolved: 'https://registry.npmjs.org/zod/-/zod-3.21.4.tgz' },
      } }));
      const result = await prepareAudit(root, 'package.json', 'npm', out, new Set(['package-lock.json']));
      expect(result.skipped).toBe(0);
      const lock = JSON.parse(await readFile(join(out, 'package-lock.json'), 'utf8'));
      expect(lock.packages['node_modules/zod']?.version).toBe('3.22.4');
      expect(lock.packages['node_modules/d54-ws-1']?.version).toBe('0.0.0');
      expect(lock.packages['node_modules/d54-ws-1/node_modules/zod']?.version).toBe('3.21.4');
      expect(lock.packages['apps/web']).toBeUndefined();
      expect(lock.packages['node_modules/@mono/web']).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('private resolved skipped not fatal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'd54-priv-'));
    const out = join(root, 'out');
    try {
      await mkdir(out);
      await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
        '': { name: 'app', version: '1.0.0' },
        'node_modules/internal-pkg': { version: '1.0.0', resolved: 'https://npm.internal.example/internal-pkg.tgz' },
        'node_modules/zod': { version: '3.22.4', resolved: 'https://registry.npmjs.org/zod/-/zod-3.22.4.tgz' },
      } }));
      const result = await prepareAudit(root, 'package.json', 'npm', out, new Set(['package-lock.json']));
      expect(result.skipped).toBe(1);
      const lock = JSON.parse(await readFile(join(out, 'package-lock.json'), 'utf8'));
      expect(lock.packages['node_modules/internal-pkg']).toBeUndefined();
      expect(lock.packages['node_modules/zod']?.version).toBe('3.22.4');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('npm takma ad girdisinde yolu koruyup gerçek paket adını yazar, güvensiz takma adı atlar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'd54-alias-'));
    const out = join(root, 'out');
    try {
      await mkdir(out);
      await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
        '': { name: 'mobile', version: '1.0.0' },
        'node_modules/@babel/traverse--for-generate-function-map': {
          version: '7.24.0',
          name: '@babel/traverse',
          resolved: 'https://registry.npmjs.org/@babel/traverse/-/traverse-7.24.0.tgz',
        },
        'node_modules/bad-alias': {
          version: '1.0.0',
          name: '../evil',
        },
      } }));
      const result = await prepareAudit(root, 'package.json', 'npm', out, new Set(['package-lock.json']));
      expect(result.skipped).toBe(1);
      const lock = JSON.parse(await readFile(join(out, 'package-lock.json'), 'utf8'));
      const aliasEntry = lock.packages['node_modules/@babel/traverse--for-generate-function-map'];
      expect(aliasEntry?.version).toBe('7.24.0');
      expect(aliasEntry?.name).toBe('@babel/traverse');
      expect(lock.packages['node_modules/bad-alias']).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('pip-audit bulunamadığında kurulum talimatı içeren not üretir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'd54-pip-'));
    const emptyBin = await mkdtemp(join(tmpdir(), 'd54-bin-'));
    const prevPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      await writeFile(join(root, 'requirements.txt'), 'requests==2.28.0\n');
      const file = source('requirements.txt', 'requests==2.28.0\n');
      const result = await scanTools(root, [file], false, ['security']);
      expect(result.notes).toContain('pip-audit bulunamadı. Kurulum: pipx install pip-audit');
    } finally {
      process.env.PATH = prevPath;
      await rm(emptyBin, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('güvenilir modda güven atlama notu üretilmez', async () => {
    const root = await mkdtemp(join(tmpdir(), 'd54-trusted-'));
    try {
      const file = source('src/a.ts', '');
      const result = await scanTools(root, [file], true, ['errors']);
      expect(result.notes.join(' ')).not.toContain('Tip/lint/derleme atlandı');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('büyük dosyalarda ilk 10 yol ve kalan sayısını içeren not üretir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'd54-large-'));
    try {
      const bigBuffer = Buffer.alloc(1_048_576 + 10, 'a');
      for (let i = 1; i <= 12; i++) {
        await writeFile(join(root, `big-${String(i).padStart(2, '0')}.js`), bigBuffer);
      }
      const result = await snapshot(root);
      const largeNote = result.notes.find(n => n.startsWith('Boyut sınırı nedeniyle içeriği okunmayan:'));
      expect(largeNote).toBeDefined();
      expect(largeNote).toContain('big-01.js');
      expect(largeNote).toContain('big-10.js');
      expect(largeNote).toContain('(+2)');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('atlanan kilit girdileri için güncel coverage notu üretir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'd54-audit-note-'));
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }));
      await writeFile(join(root, 'package-lock.json'), JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'app', version: '1.0.0' },
          'node_modules/internal-pkg': { version: '1.0.0', resolved: 'https://npm.internal.example/internal-pkg.tgz' },
        },
      }));
      const filePkg = source('package.json', '{"name":"app","version":"1.0.0"}');
      const fileLock = source('package-lock.json', '{}');
      const result = await scanTools(root, [filePkg, fileLock], false, ['security']);
      expect(result.notes.some(n => n.includes('kilit girdisi denetim dışı kaldı (npm dışı kaynak, geçersiz ad/sürüm veya atlanan üst paket)'))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('kendi kilidi olmayan workspace üyesinde üst kilit varsa kök kilidiyle denetlendi notu üretir ve görev eklemez', async () => {
    const root = await mkdtemp(join(tmpdir(), 'd54-ws-lock-'));
    const emptyBin = await mkdtemp(join(tmpdir(), 'd54-ws-bin-'));
    const prevPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      const files = [
        source('package.json', '{"name":"mono","private":true}'),
        source('package-lock.json', '{}'),
        source('apps/web/package.json', '{"name":"web"}'),
        source('packages/npm-shrinkwrap.json', '{}'),
        source('packages/ui/package.json', '{"name":"ui"}'),
      ];
      const result = await scanTools(root, files, false, ['security']);
      expect(result.notes.some(n => n.includes('apps/web/package.json') && n.includes('kök kilidiyle denetlendi (package-lock.json)'))).toBe(true);
      expect(result.notes.some(n => n.includes('packages/ui/package.json') && n.includes('kök kilidiyle denetlendi (packages/npm-shrinkwrap.json)'))).toBe(true);
      expect(result.notes.join('\n')).not.toContain('npm kilit dosyası bulunamadı');
      expect(result.completion.map(c => c.file)).toEqual(['package.json']);
    } finally {
      process.env.PATH = prevPath;
      await rm(emptyBin, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('kardeş pnpm-lock.yaml veya yarn.lock varsa desteklenmiyor notu üretir ve görev eklemez', async () => {
    const root = await mkdtemp(join(tmpdir(), 'd54-alt-lock-'));
    try {
      const pnpmRes = await scanTools(root, [source('package.json', '{}'), source('pnpm-lock.yaml', '')], false, ['security']);
      expect(pnpmRes.notes.some(n => n.includes('pnpm/yarn kilidi desteklenmiyor; npm danışmanlık denetimi atlandı'))).toBe(true);
      expect(pnpmRes.completion).toEqual([]);

      const yarnRes = await scanTools(root, [source('apps/api/package.json', '{}'), source('apps/api/yarn.lock', '')], false, ['security']);
      expect(yarnRes.notes.some(n => n.includes('apps/api/package.json') && n.includes('pnpm/yarn kilidi desteklenmiyor; npm danışmanlık denetimi atlandı'))).toBe(true);
      expect(yarnRes.completion).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
