import ts from 'typescript';
import type { Issue, SourceFile } from '../types.js';
import { isScript, lineOf, report, scanLines, treeOf, walk } from './static-utils.js';

function rustLines(file: SourceFile, check: (code: string, line: number, documented: boolean) => void): void {
  let commentDepth = 0, quoted = false, rawEnd = '', safety = false;
  let testItem = false, testDepth = 0;
  scanLines(file, (source, line) => {
    let code = '', comment = '';
    for (let i = 0; i < source.length;) {
      if (rawEnd) {
        const end = source.indexOf(rawEnd, i);
        if (end < 0) break;
        i = end + rawEnd.length; rawEnd = ''; continue;
      }
      if (quoted) {
        if (source[i] === '\\') i += 2;
        else if (source[i++] === '"') quoted = false;
        continue;
      }
      if (source.startsWith('/*', i)) { commentDepth++; i += 2; continue; }
      if (commentDepth) {
        if (source.startsWith('*/', i)) { commentDepth--; i += 2; }
        else comment += source[i++];
        continue;
      }
      if (source.startsWith('//', i)) { comment += source.slice(i + 2); break; }
      if ((source[i] === 'r' || source[i] === 'b') && /[r"#]/.test(source[i + 1] ?? '')) {
        const raw = /^b?r(#{0,255})"/.exec(source.slice(i));
        if (raw) { rawEnd = '"' + raw[1]; i += raw[0].length; code += ' '; continue; }
      }
      if (source[i] === '"') { quoted = true; i++; code += ' '; continue; }
      if (source[i] === "'") {
        const character = /^'(?:\\.|[^'\\])'/.exec(source.slice(i, i + 5));
        if (character) { i += character[0].length; code += ' '; continue; }
      }
      code += source[i++];
    }
    safety ||= /\bSAFETY\s*:/i.test(comment);
    if (!code.trim()) { if (!comment.trim() && !commentDepth) safety = false; return; }
    const attr = /#\s*\[\s*(?:cfg\s*\(\s*test\s*\)|test)\s*\]/.exec(code);
    if (attr && testDepth === 0) { testItem = true; code = code.slice(attr.index + attr[0].length); }
    if (testItem) {
      let started = testDepth > 0, end = -1;
      for (let i = 0; i < code.length; i++) {
        if (code[i] === '{') { started = true; testDepth++; }
        if (code[i] === '}' && testDepth) testDepth--;
        if ((!started && code[i] === ';') || (started && testDepth === 0)) { end = i; break; }
      }
      if (end < 0) return;
      testItem = false; code = code.slice(end + 1);
    }
    check(code, line, safety);
    safety = false;
  });
}

function globScope(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(globScope);
  if (value !== null && typeof value === 'object') {
    const scope = value as Record<string, unknown>;
    return globScope(scope.allow) || globScope(scope.path);
  }
  return typeof value === 'string' && (value === '*' || /(?:^|[\\/])\*\*(?:$|[\\/])/.test(value));
}

function refName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(node)) {
    const base = refName(node.expression);
    if (base) return base + '.' + node.name.text;
  }
  return undefined;
}

function boundName(node: ts.Node): string | undefined {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) return refName(parent.name);
  if (ts.isBinaryExpression(parent) && parent.right === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return refName(parent.left);
  if (ts.isPropertyDeclaration(parent) && parent.initializer === node) return 'this.' + parent.name.getText();
  return undefined;
}

function scopeOf(node: ts.Node, name: string | undefined): ts.Node {
  let parent = node.parent;
  while (parent && !ts.isSourceFile(parent)) {
    if (name?.startsWith('this.') ? ts.isClassLike(parent) : ts.isBlock(parent)) return parent;
    parent = parent.parent;
  }
  return parent;
}

function nested(node: ts.Node, scope: ts.Node): boolean {
  return node.pos >= scope.pos && node.end <= scope.end;
}

export function scan(file: SourceFile, _files: readonly SourceFile[]): Issue[] {
  const issues: Issue[] = [];
  const add = (line: number, rule: string, severity: Issue['severity'], title: string, evidence: string, impact: string, advice: string) =>
    issues.push(report(file, line, 'specialized', rule, severity, title, evidence, impact, advice));
  if (/\.rs$/i.test(file.path)) {
    rustLines(file, (code, line, documented) => {
      if (!documented && /\bunsafe\s*(?:\{|fn\b|impl\b|trait\b)/.test(code)) add(line, 'specialized.rust-unsafe', 'medium', 'Rust unsafe sınırının gerekçesi görünmüyor',
        'Unsafe blok veya bildirimden hemen önce bir SAFETY açıklaması bulunamadı.', 'Bellek ve iş parçacığı güvenliği sözleşmesi elle doğrulanmalıdır.',
        'Güvenlik varsayımlarını çağrı yerleriyle birlikte inceleyip SAFETY yorumunda belgeleyin.');
      if (/\.\s*(?:unwrap|expect)\s*\(|\bpanic!\s*\(/.test(code)) add(line, 'specialized.rust-panic', 'medium', 'Rust kodunda panic yolu',
        'Panic oluşturabilen çağrı bulundu.', 'Beklenmedik girdi çağrıyı veya uygulamayı durdurabilir.',
        'Hata oluşabiliyorsa Result döndürün veya uygun varsayılan davranışı açıkça tanımlayın.');
    });
  }
  if (/(?:^|\/)(?:tauri\.conf\.json|capabilities\/[^/]+\.json)$/.test(file.path)) {
    try {
      const settings = JSON.parse(file.text);
      const broad = settings?.tauri?.allowlist?.all === true || Object.values(settings?.tauri?.allowlist ?? {})
        .some(value => typeof value === 'object' && value !== null && 'all' in value && value.all === true);
      const oldGlob = globScope(settings?.tauri?.allowlist?.fs?.scope);
      const permissions: unknown = settings?.permissions;
      const wildcard = Array.isArray(permissions) && permissions.some(entry => {
        const id = typeof entry === 'string' ? entry : entry?.identifier;
        return typeof id === 'string' && (id.includes('*') || /^(?:shell:allow-(?:execute|spawn)|fs:allow-.*-recursive)$/.test(id)
          || (id.startsWith('fs:') && globScope(entry?.allow)));
      });
      if (broad || oldGlob || wildcard) {
        const index = file.text.search(broad ? /"all"\s*:\s*true/ : oldGlob ? /"scope"\s*:/ : /"permissions"\s*:/);
        const line = file.text.slice(0, Math.max(0, index)).split('\n').length;
        add(line, 'specialized.tauri-permissions', 'medium', 'Tauri izinlerinin kapsamını inceleyin',
          'Yapılandırmada geniş kapsamlı bir izin etkin.', 'Bir webview gereksiniminden daha fazla sistem yetkisi alabilir.',
          'İhtiyaç duyulan komutları, dosya konumlarını ve pencere etiketlerini sınırlandırın.');
      }
    } catch { /* JSON sözdizimini errors tarayıcısı raporlar. */ }
  }
  if (!isScript(file.path) || !/(?:['"]three(?:\/|['"])|\bTHREE\.|WebGLRenderer)/.test(file.text)) return issues;
  const allocations: { node: ts.NewExpression; name?: string; type: string }[] = [];
  const disposals = new Map<string, ts.Node[]>();
  const temporaryMath: ts.NewExpression[] = [];
  const callbacks: ts.Node[] = [];
  const namedCallbacks = new Set<string>();
  const functions: { name: string; node: ts.Node }[] = [];
  let renderer: number | undefined;
  let frame: number | undefined;
  let hasCancel = false;
  let hasContextListener = false;
  walk(treeOf(file), node => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const name = ts.isMethodDeclaration(node) ? 'this.' + node.name.getText()
        : ts.isFunctionDeclaration(node) ? node.name?.text : boundName(node);
      if (name) functions.push({ name, node });
    }
    if (ts.isNewExpression(node)) {
      const name = node.expression.getText().split('.').pop() ?? '';
      if (/(?:Geometry|Material|Texture|WebGLRenderTarget|WebGLRenderer)$/.test(name)) allocations.push({ node, name: boundName(node), type: name });
      if (/^(?:Vector[234]|Matrix[34])$/.test(name)) temporaryMath.push(node);
      if (name === 'WebGLRenderer') renderer = Math.min(renderer ?? Infinity, lineOf(node));
    }
    if (!ts.isCallExpression(node)) return;
    const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : '';
    if (name === 'dispose' && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = refName(node.expression.expression);
      if (receiver) {
        const calls = disposals.get(receiver) ?? [];
        calls.push(node); disposals.set(receiver, calls);
      }
    }
    if (name === 'requestAnimationFrame') frame = Math.min(frame ?? Infinity, lineOf(node));
    if (name === 'cancelAnimationFrame') hasCancel = true;
    const first = node.arguments[0];
    if (first && (name === 'requestAnimationFrame' || name === 'setAnimationLoop')) {
      if (ts.isArrowFunction(first) || ts.isFunctionExpression(first)) callbacks.push(first);
      else { const ref = refName(first); if (ref) namedCallbacks.add(ref); }
    }
    if (name === 'addEventListener' && first && ts.isStringLiteral(first) && first.text === 'webglcontextlost') hasContextListener = true;
  });
  for (const { node, name, type } of allocations) {
    const scope = scopeOf(node, name);
    if (name && disposals.get(name)?.some(call => nested(call, scope))) continue;
    const kind = /Geometry$/.test(type) ? 'geometri' : /Material$/.test(type) ? 'malzeme' : /Texture$/.test(type) ? 'doku' : /Renderer$/.test(type) ? 'renderer' : 'render hedefi';
    add(lineOf(node), 'specialized.three-disposal', 'medium', 'Three.js ' + kind + ' temizliğini inceleyin',
      'Oluşturulan kaynak için aynı kapsamda doğrudan bir dispose çağrısı eşleştirilemedi.',
      'Tekrarlanan kurulumlarda GPU belleği büyüyebilir.', 'Kaynağın sahibini izleyip sahne kapanışındaki dispose çağrısını doğrulayın.');
  }
  for (const fn of functions) if (namedCallbacks.has(fn.name)) callbacks.push(fn.node);
  for (const allocation of temporaryMath) {
    if (callbacks.some(cb => nested(allocation, cb))) add(lineOf(allocation), 'specialized.three-frame-allocation', 'medium',
      'Animasyon karesinde vektör veya matris oluşturuluyor', 'Kare geri çağrısının içinde yeni bir Three.js matematik nesnesi ayrılıyor.',
      'Sık tahsisler çöp toplama duraklamalarını artırabilir.', 'Yaşam döngüsü izin veriyorsa nesneyi kare döngüsü dışında oluşturup yeniden kullanın.');
  }
  if (frame && !hasCancel) add(frame, 'specialized.three-animation', 'medium', 'Animasyon karesinin yaşam döngüsünü inceleyin',
    'Bu dosyada requestAnimationFrame çağrısı var. cancelAnimationFrame çağrısı bulunamadı.',
    'Kendini yineleyen animasyon sahne kapandıktan sonra sürebilir.', 'Kare kimliğini ve kapanış sırasında kullanılan iptal veya durdurma koşulunu doğrulayın.');
  if (renderer && !hasContextListener) add(renderer, 'specialized.three-context', 'low', 'WebGL bağlam kaybı davranışını inceleyin',
    'Renderer oluşturuluyor. Dosyada webglcontextlost dinleyicisi bulunamadı.', 'Bağlam kaybında uygulamanın kullanıcıya sunduğu görünüm kesilebilir.',
    'Renderer sürümünün dahili kurtarma davranışını ve uygulamanın kaynakları geri yükleme akışını doğrulayın.');
  return issues;
}
