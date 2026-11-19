import ts from 'typescript';
import type { Issue, SourceFile } from '../types.js';
import { isScript, lineOf, report, treeOf, walk } from './static-utils.js';

export function scan(file: SourceFile, _files: readonly SourceFile[]): Issue[] {
  const issues: Issue[] = [];
  if (!isScript(file.path)) return issues;
  walk(treeOf(file), node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'forEach' && node.arguments.some(arg =>
          (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && arg.modifiers?.some(mod => mod.kind === ts.SyntaxKind.AsyncKeyword))) {
      issues.push(report(file, lineOf(node), 'bugs', 'bugs.async-foreach', 'high', 'forEach eşzamansız sonucu beklemiyor',
        'forEach içinde async geri çağrısı kullanılıyor.', 'Çağıran kod önce bitebilir veya reddedilen işlem işlenmeyebilir.',
        'İşlerin sırasına göre for…of ve await ya da sonuçları beklenen Promise.all kullanın.'));
    }
    if (!ts.isBinaryExpression(node)) return;
    if ([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind) &&
      [node.left, node.right].some(expr => ts.isIdentifier(expr) && expr.text === 'NaN')) {
      issues.push(report(file, lineOf(node), 'bugs', 'bugs.nan-comparison', 'medium', 'NaN eşitlik işleciyle karşılaştırılıyor',
        'Eşitlik veya eşitsizlik karşılaştırmasında NaN sabiti kullanılıyor.', 'Koşul sayı olmayan değeri amaçlandığı gibi ayırt edemez.',
        'Sayısal değer için Number.isNaN kullanın.'));
    }
    if ([ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken].includes(node.operatorToken.kind)
        && ts.isNumericLiteral(node.right) && Number(node.right.text) === 0) {
      issues.push(report(file, lineOf(node), 'bugs', 'bugs.zero-divisor', 'medium', 'Sıfır bölen kullanılmış',
        'Bölme veya kalan işleminde bölen sayısal sıfır.', 'Sonuç sonlu sayı bekleyen kodu bozabilir.',
        'Bölenin kaynağını düzeltin ve sıfır durumunu açıkça işleyin.'));
    }
  });
  return issues;
}
