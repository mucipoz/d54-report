import { basename } from 'node:path';
import ts from 'typescript';
import type { Issue, SourceFile } from '../types.js';
import { isScript, lineOf, report, scanLines, treeOf, walk } from './static-utils.js';

const credentialName = /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)$/i;
const sample = /^(?:[<{$*]|\.{2}|x{3,}|example|sample|demo|dummy|test|fake|fixture|placeholder|replace|change[-_]?me|your[-_]|redacted|none$|null$)/i;
const knownCredential = /(?:\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----)/;

function literalCredential(name: string, value: string): boolean {
  return credentialName.test(name) && value.trim().length >= 6 && !sample.test(value.trim())
    && !/^(?:https?:\/\/|process\.env\.|os\.(?:environ|getenv)|env\()/.test(value.trim());
}

export function scan(file: SourceFile, _files: readonly SourceFile[]): Issue[] {
  const issues: Issue[] = [];
  const script = isScript(file.path);
  const env = /^\.env(?:\.|$)/i.test(basename(file.path));
  const settings = env || /\.(?:json|ya?ml|toml|ini|properties|conf|py|php|rb|rs)$/i.test(file.path);
  const seen = new Set<string>();
  const add = (line: number, rule: string, severity: Issue['severity'], title: string, evidence: string, impact: string, advice: string) => {
    const key = line + '/' + rule;
    if (!seen.has(key)) issues.push(report(file, line, 'security', rule, severity, title, evidence, impact, advice));
    seen.add(key);
  };
  const secret = (line: number) => add(line, 'security.literal-secret', 'high', 'Kaynakta olası kimlik bilgisi',
    'Bir kimlik bilgisi örüntüsü veya sabit hassas ayar değeri bulundu. Değer gizlendi.',
    'Gerçek bir değer ise kaynak dosyaya erişen kişiler hesabı kullanabilir.', 'Değeri doğrulayın. Gerçekse anahtarı yenileyip bir gizli değer deposuna taşıyın.');
  scanLines(file, (line, number) => {
    if (knownCredential.test(line)) secret(number);
    if (settings && !/^\s*[#;]/.test(line)) {
      for (const match of line.matchAll(/(?:^|[\s{,])["']?([\w-]+)["']?\s*[:=]\s*(?:"([^"\n]+)"|'([^'\n]+)'|([^\s#,}]+))/g)) {
        const value = match[2] ?? match[3] ?? match[4] ?? '';
        if ((match[2] !== undefined || match[3] !== undefined || env || /\.(?:ya?ml|ini|properties|conf)$/i.test(file.path))
            && literalCredential(match[1]!, value)) secret(number);
      }
    }
  });
  if (/\.(?:html?|vue|svelte|astro|[jt]sx)$/i.test(file.path)) {
    let previous = 0;
    let line = 1;
    const markup = file.text.replace(/<!--[\s\S]*?-->/g, value => value.replace(/[^\n]/g, ' '));
    for (const match of markup.matchAll(/<a(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi)) {
      const index = match.index!;
      line += file.text.slice(previous, index).split('\n').length - 1;
      previous = index;
      const attributes = new Map<string, string>();
      for (const attr of match[0].slice(2, -1).matchAll(/\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        attributes.set(attr[1]!.toLowerCase(), (attr[2] ?? attr[3] ?? attr[4] ?? '').toLowerCase());
      }
      if (attributes.get('target') !== '_blank') continue;
      const rel = (attributes.get('rel') ?? '').split(/\s+/);
      if (!rel.includes('noopener') && !rel.includes('noreferrer')) add(line, 'security.target-blank', 'low',
        'Yeni sekme bağlantısında ilişki açık belirtilmemiş', 'Hedef _blank. Rel içinde noopener veya noreferrer bulunamadı.',
        'Örtük koruması olmayan istemciler açan pencereye erişim verebilir.', 'Bağlantının rel özniteliğine noopener ekleyin.');
    }
  }
  if (!script) return issues;
  walk(treeOf(file), node => {
    if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer
        && ts.isStringLiteralLike(node.initializer) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
        && literalCredential(node.name.text, node.initializer.text)) secret(lineOf(node));
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      const first = node.arguments[0];
      if (name === 'eval' && first && !ts.isStringLiteralLike(first)) add(lineOf(node), 'security.dynamic-eval', 'high',
        'Dinamik kod değerlendirmesi', 'Eval çağrısı sabit olmayan bir ifade alıyor.', 'Girdi güven sınırını geçiyorsa uygulama beklenmeyen kod çalıştırabilir.', 'Girdi kaynağını izleyin ve izinli işlemleri doğrudan çağırın.');
      if (first && ['query', 'execute', 'raw'].includes(name)
          && (ts.isTemplateExpression(first) || (ts.isBinaryExpression(first) && first.operatorToken.kind === ts.SyntaxKind.PlusToken))
          && /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i.test(first.getText())) add(lineOf(node), 'security.sql-construction', 'high',
        'SQL sorgusu ifadelerden oluşturuluyor', 'SQL metni şablon genişletmesi veya metin birleştirme içeriyor.', 'Dış girdiler sorgunun yapısını değiştirebilir.', 'Veri akışını inceleyip sorgu parametreleri kullanın.');
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left) && ['innerHTML', 'outerHTML'].includes(node.left.name.text)
        && !ts.isStringLiteralLike(node.right)) add(lineOf(node), 'security.dynamic-html', 'medium',
      'HTML içeriği dinamik atanıyor', 'Bir DOM HTML özelliğine dinamik ifade yazılıyor.', 'Temizlenmemiş dış girdi tarayıcıda etkin içerik oluşturabilir.', 'Salt metinde textContent kullanın. HTML gerekiyorsa kaynağı ve temizleyiciyi doğrulayın.');
    if (ts.isPropertyAssignment(node) && node.name.getText().replace(/["']/g, '') === 'rejectUnauthorized'
        && node.initializer.kind === ts.SyntaxKind.FalseKeyword) add(lineOf(node), 'security.tls-validation', 'high',
      'TLS sunucu doğrulaması kapalı', 'TLS ayarında sertifika doğrulaması devre dışı bırakılmış.', 'Yanlış sunucu kimliği kabul edilebilir.', 'Güvenilen sertifika zincirini yapılandırıp doğrulamayı etkinleştirin.');
  });
  return issues;
}
