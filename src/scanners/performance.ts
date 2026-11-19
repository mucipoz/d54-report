import ts from 'typescript';
import type { Issue, SourceFile } from '../types.js';
import { isScript, lineOf, report, treeOf, walk } from './static-utils.js';

function insideLoop(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isIterationStatement(parent, false)) return true;
    if (ts.isFunctionLike(parent)) return false;
  }
  return false;
}

export function scan(file: SourceFile, _files: readonly SourceFile[]): Issue[] {
  const issues: Issue[] = [];
  if (/\.(?:png|jpe?g|webp|svg|gltf|glb|json|js|css)$/i.test(file.path) && file.size > 1024 * 1024
      && !/(?:lock\.json|\.map)$/i.test(file.path)) {
    issues.push(report(file, 1, 'performance', 'performance.large-asset', 'low', 'Büyük dosyanın yükleme maliyetini inceleyin',
      'Dosya boyutu ' + Math.ceil(file.size / 1024) + ' KiB.', 'İlk yüklemede sunuluyorsa aktarım veya ayrıştırma süresi uzayabilir.',
      'Üretim çıktısına girip girmediğini ölçün. Gerekiyorsa sıkıştırma veya gecikmeli yükleme uygulayın.'));
  }
  if (!isScript(file.path)) return issues;
  walk(treeOf(file), node => {
    if (ts.isAwaitExpression(node) && insideLoop(node)) {
      issues.push(report(file, lineOf(node), 'performance', 'performance.await-loop', 'low', 'Döngü her işlem için bekliyor',
        'Döngü içinde await kullanılmış.', 'Birbirinden bağımsız işlemler seri çalıştığında toplam süre uzayabilir.',
        'İşlem sırasını ve hız sınırlarını kontrol edin. Bağımsız işler için sınırlı eşzamanlılığı değerlendirin.'));
    }
    if (!ts.isCallExpression(node)) return;
    const called = node.expression;
    const name = ts.isIdentifier(called) ? called.text : ts.isPropertyAccessExpression(called) ? called.name.text : '';
    if (!insideLoop(node)) return;
    if (/^(?:readFile|writeFile|readdir|stat|exec|spawn)Sync$/.test(name)) {
      issues.push(report(file, lineOf(node), 'performance', 'performance.sync-io-loop', 'medium', 'Döngü içinde eşzamanlı G/Ç',
        'Döngü gövdesi eşzamanlı dosya veya süreç işlemi çağırıyor.', 'Büyük girdiler olay döngüsünü uzun süre meşgul edebilir.',
        'Ölçüm yapın ve işlemi döngü dışına alın veya eşzamansız API kullanın.'));
    }
    if (['find', 'findIndex', 'indexOf'].includes(name)) {
      issues.push(report(file, lineOf(node), 'performance', 'performance.linear-lookup-loop', 'low', 'Döngüde doğrusal arama',
        'Her yinelemede bir doğrusal arama çağrılabilir.', 'Aranan koleksiyon girdiyle birlikte büyüyorsa maliyet karesel olabilir.',
        'Koleksiyon boyutlarını ölçün. Tekrarlanan anahtar aramalarında Map veya Set kullanın.'));
    }
  });
  return issues;
}
