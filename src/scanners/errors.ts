import { posix } from 'node:path';
import ts from 'typescript';
import type { Issue, SourceFile } from '../types.js';
import { isScript, lineOf, pathsOf, report, treeOf, walk } from './static-utils.js';

const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.d.ts'];
const declarations = new WeakMap<readonly SourceFile[], Map<string, Set<string>>>();

function envDeclarations(files: readonly SourceFile[]): Map<string, Set<string>> {
  let result = declarations.get(files);
  if (result) return result;
  result = new Map();
  for (const file of files) {
    if (!/^\.env\.(?:example|sample|template)$/i.test(posix.basename(file.path))) continue;
    const dir = posix.dirname(file.path);
    const keys = result.get(dir) ?? new Set<string>();
    for (const match of file.text.matchAll(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/gm)) keys.add(match[1]!);
    result.set(dir, keys);
  }
  declarations.set(files, result);
  return result;
}

function nearestEnv(path: string, files: readonly SourceFile[]): Set<string> | undefined {
  const catalog = envDeclarations(files);
  let dir = posix.dirname(path);
  while (true) {
    if (catalog.has(dir)) return catalog.get(dir);
    const next = posix.dirname(dir);
    if (next === dir) return undefined;
    dir = next;
  }
}

function missingImport(file: SourceFile, spec: string, paths: ReadonlySet<string>): boolean {
  if (!/^\.{1,2}\//.test(spec) || /[?#*]/.test(spec)) return false;
  const path = posix.join(posix.dirname(file.path), spec);
  if (paths.has(path)) return false;
  const ext = posix.extname(path);
  if (ext && !extensions.includes(ext)) return false;
  // TypeScript commonly spells source imports with their emitted JavaScript extension.
  const substitutions: Record<string, string[]> = {
    '.js': ['.ts', '.tsx', '.d.ts', '.jsx'], '.jsx': ['.tsx', '.d.ts'],
    '.mjs': ['.mts', '.d.mts'], '.cjs': ['.cts', '.d.cts'],
  };
  if (ext) return !(substitutions[ext] ?? []).some(suffix => paths.has(path.slice(0, -ext.length) + suffix));
  return !extensions.some(suffix => paths.has(path + suffix) || paths.has(posix.join(path, 'index' + suffix)))
    && !paths.has(posix.join(path, 'package.json'));
}

export function scan(file: SourceFile, files: readonly SourceFile[]): Issue[] {
  const issues: Issue[] = [];
  if (!file.text && file.size > 0) return issues;
  const config = /(?:^|\/)(?:tsconfig(?:\.[^/]+)?|jsconfig)\.json$/i.test(file.path);
  if (/\.json$/i.test(file.path)) {
    if (config) {
      const diagnostic = ts.parseConfigFileTextToJson(file.path, file.text).error;
      if (diagnostic) {
        const line = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line ?? 0;
        issues.push(report(file, line + 1, 'errors', 'errors.config-json', 'high', 'Yapılandırma okunamıyor',
          'TypeScript yapılandırma ayrıştırıcısı bir sözdizimi hatası bildirdi.', 'Derleyici ayarları yüklenemeyebilir.', 'Belirtilen satırdaki JSONC sözdizimini düzeltin.'));
      }
    } else {
      try { JSON.parse(file.text.replace(/^\uFEFF/, '')); }
      catch (error) {
        const message = error instanceof Error ? error.message : '';
        const line = Number(message.match(/\bline (\d+)/i)?.[1])
          || file.text.slice(0, Number(message.match(/position (\d+)/i)?.[1]) || 0).split('\n').length;
        issues.push(report(file, line, 'errors', 'errors.invalid-json', 'high', 'JSON sözdizimi geçersiz',
          'JSON ayrıştırıcısı dosyayı okuyamadı.', 'Bu dosyayı kullanan adım durabilir.', 'Belirtilen konumdaki tırnak, ayraç ve parantezleri kontrol edin.'));
      }
    }
  }
  if (!isScript(file.path)) return issues;
  const tree = treeOf(file);
  const syntax = (tree as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  for (const diagnostic of syntax) {
    const line = tree.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
    issues.push(report(file, line, 'errors', 'errors.syntax', 'high', 'Kaynak dosyada sözdizimi hatası',
      'TypeScript ayrıştırıcısı TS' + diagnostic.code + ' tanısını bildirdi.', 'Dosya derlenemeyebilir.', 'Belirtilen satırdaki sözdizimini düzeltip derlemeyi yineleyin.'));
  }
  const paths = pathsOf(files);
  const env = nearestEnv(file.path, files);
  walk(tree, node => {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) ? node.arguments[0] : undefined;
    if (specifier && ts.isStringLiteral(specifier) && missingImport(file, specifier.text, paths)) {
      issues.push(report(file, lineOf(specifier), 'errors', 'errors.missing-import', 'medium', 'Göreli modül taranan dosyalarda bulunamadı',
        'Sabit bir göreli içe aktarım için eşleşen kaynak bulunamadı.', 'Derleme veya modül yüklemesi başarısız olabilir.', 'Yolu, harf büyüklüğünü ve üretim adımıyla oluşan dosyaları kontrol edin.'));
    }
    if (env && ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'env' && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'process'
        && !env.has(node.name.text) && !['NODE_ENV', 'PATH', 'HOME', 'CI', 'PWD', 'PORT'].includes(node.name.text)) {
      issues.push(report(file, lineOf(node), 'errors', 'errors.env-template', 'low', 'Ortam değişkeni örnek dosyada tanımlı değil',
        'Kaynakta okunan değişken en yakın ortam şablonunda yok.', 'Yeni kurulumda bir ayar eksik kalabilir.', 'Değişken gerekli ise örnek ortama boş veya örnek bir değer ekleyin.'));
    }
    if (ts.isCatchClause(node) && !node.block.statements.length) {
      issues.push(report(file, lineOf(node), 'errors', 'errors.empty-catch', 'medium', 'Hata sessizce yutuluyor',
        'Catch bloğunda hiçbir ifade yok.', 'Hatalı durum başarılı gibi devam edebilir.', 'Beklenen hatayı açıkça ele alın veya üst katmana iletin.'));
    }
  });
  return issues;
}
