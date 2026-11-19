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
  it('varsayılan modda proje derleme betiğini atlar', async () => {
    const file = source('package.json', '{"scripts":{"build":"fixture-build"}}');
    const result = await scanTools(tmpdir(), [file], false);
    expect(result.issues).toEqual([]);
    expect(result.notes.join(' ')).toContain('derleme araçları atlandı');
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
});
