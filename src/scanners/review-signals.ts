import ts from 'typescript';
import { basename } from 'node:path';
import { isScript, lineOf, report, treeOf, walk } from './static-utils.js';
import { categories, type Category, type Issue, type SourceFile } from '../types.js';

export function scanSignals(file:SourceFile, modules: readonly Category[] = categories): Issue[] {
  const findings:Issue[]=[];
  const emit=(line:number, category:Issue['category'], rule:string, severity:Issue['severity'], title:string, evidence:string, impact:string, advice:string)=>
    findings.push(report(file,line,category,category+'.'+rule,severity,title,evidence,impact,advice));
  const security = modules.includes('security'), performance = modules.includes('performance');
  const bugs = modules.includes('bugs'), errors = modules.includes('errors');
  if (!security && !performance && !bugs && !errors) return findings;
  const env=basename(file.path);
  if (security && /^\.env(?:$|\.)/.test(env) && !/^\.env\.(?:example|sample|template)$/.test(env)) {
    emit(1,'security','env-file','medium','Proje ağacında ortam dosyası var','Dosya adı kaydedildi, içeriği okunmadı.','Paketleme veya sürüm kontrolü ortam değerlerini açığa çıkarabilir.','Dosyanın izlenme durumunu ve paketleme dışlamalarını doğrulayın.');
  }
  if (security && /\.(?:key|pem)$/i.test(env)) emit(1,'security','key-file','medium','Anahtar veya sertifika dosyasını inceleyin','Dosya uzantısı anahtar materyali için kullanılıyor.','Üretime ait özel anahtar yayıma girebilir.','Dosyanın genel sertifika mı özel anahtar mı olduğunu yerelde doğrulayın.');
  if (!file.text) return findings;
  const source=isScript(file.path);
  if (!source && !/\.(?:py|rs|php|sql|html?|[sy]aml|toml|json|vue|svelte)$/.test(file.path)) return findings;
  if (bugs && file.text.includes('\uFFFD')) emit(file.text.slice(0,file.text.indexOf('\uFFFD')).split('\n').length,'bugs','encoding','medium','Metinde Unicode ikame karakteri var','UTF-8 çözümlemesi U+FFFD üretti veya kaynakta bu karakter bulunuyor.','Türkçe karakterler yanlış görüntülenebilir veya karşılaştırmalar değişebilir.','Dosya kodlamasını ve UTF-8 olarak kaydedilen özgün metni kontrol edin.');
  if (source) scanScript(file,emit,{security,performance,bugs,errors});
  if ((security || performance) && /\.(?:py|php)$/.test(file.path)) {
    const lines=file.text.split(/\r?\n/);
    lines.forEach((line,i)=>{
      if (/^\s*(?:#|\/\/|\*)/.test(line)) return;
      if (security && /\b(?:pickle\.loads?|yaml\.unsafe_load|unserialize)\s*\(/.test(line)) emit(i+1,'security','deserialization','high','Nesne deserializasyonunun kaynağını doğrulayın','Nesne oluşturabilen bir veri yükleme çağrısı bulundu.','Güvenilmeyen veri beklenmeyen sınıfları etkinleştirebilir.','Şemalı veri biçimi kullanın ve girdi kaynağını sınırlayın.');
      if (security && /^\s*@(?:\w+\.)?csrf_exempt\b/.test(line)) emit(i+1,'security','csrf-exempt','medium','CSRF denetimi devre dışı','İstek işleyicisi CSRF muafiyeti taşıyor.','Çerez tabanlı oturumlarda durum değiştiren işlemler etkilenebilir.','İstek yöntemlerini ve kimlik doğrulama türünü doğrulayın. Uygun CSRF korumasını açın.');
      if (performance && /\b(?:open|sqlite3\.connect)\s*\(/.test(line) && /^\s*\w+\s*=/.test(line) && !/\.close\s*\(/.test(file.text)) emit(i+1,'performance','open-handle','medium','Kaynak kapatma yolunu inceleyin','Kaynak bir değişkene atanıyor ve dosyada close çağrısı bulunmuyor.','Tekrarlanan çağrılar açık dosya veya bağlantı sayısını artırabilir.','Sahipliği izleyin. Kapanışı with veya finally ile güvenceye alın.');
    });
  }
  return findings;
}
type Emit=(line:number,category:Issue['category'],rule:string,severity:Issue['severity'],title:string,evidence:string,impact:string,advice:string)=>unknown;

function scanScript(file:SourceFile, emit:Emit, { security, performance, bugs, errors }: Record<'security' | 'performance' | 'bugs' | 'errors', boolean>) {
  const calls=new Set<string>();
  const resources:{line:number;start:string;stop:string}[]=[];
  const tree=treeOf(file);
  walk(tree,node=>{
    const line=()=>lineOf(node);
    if (performance && ts.isWhileStatement(node) && node.expression.kind===ts.SyntaxKind.TrueKeyword &&
      !/\b(?:break|return|throw|await|yield)\b/.test(node.statement.getText())) emit(line(),'performance','unbounded-loop','high','Çıkışsız senkron döngü','Sabit true döngüsünde çıkış veya bekleme görülmedi.','Ana iş parçacığı yanıt veremez hale gelebilir.','Döngüyü sınırlayın veya iptal koşulu ve bekleme ekleyin.');
    if (bugs && ts.isPropertyAccessExpression(node) && !node.questionDotToken && (node.expression.kind===ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text==='undefined'))) emit(line(),'bugs','null-access','high','Boş değer üzerinde özellik erişimi','Özellik erişiminin alıcısı null veya undefined.','Bu ifade değerlendirildiğinde istisna oluşabilir.','Nesnenin varlığını doğrulayıp boş durumu işleyin.');
    if (bugs && ts.isForStatement(node) && node.condition && ts.isBinaryExpression(node.condition) && node.condition.operatorToken.kind===ts.SyntaxKind.LessThanEqualsToken &&
      ts.isPropertyAccessExpression(node.condition.right) && node.condition.right.name.text==='length' && ts.isIdentifier(node.condition.left)) {
      const index=node.condition.left.text, array=node.condition.right.expression.getText();
      if (node.statement.getText().includes(array+'['+index+']')) emit(line(),'bugs','index-bound','medium','Döngü uzunluğu son indeks olarak kullanıyor','Döngü <= length sınırını ve aynı indeksle öğe erişimini içeriyor.','Son turda öğe undefined olabilir.','Döngü < length koşulunu veya öğeler üzerinde doğrudan yinelemeyi değerlendirin.');
    }
    if (bugs && ts.isNewExpression(node) && node.expression.getText()==='Date' && node.arguments?.length===1 && ts.isStringLiteral(node.arguments[0]) &&
      !Number.isFinite(Date.parse(node.arguments[0].text))) emit(line(),'bugs','invalid-date','medium','Geçersiz tarih sabiti','Date yapıcısının metin girdisi ayrıştırılamadı.','Tarih biçimleme işlemi istisna oluşturabilir.','ISO tarih değeri kullanıp geçersiz girdiyi doğrulayın.');
    if (bugs && ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind) &&
      [node.left,node.right].some(ts.isNumericLiteral) && [node.left,node.right].some(ts.isStringLiteral)) emit(line(),'bugs','coercion','low','Karşılaştırma örtük tür dönüşümü kullanıyor','Sayı ve metin gevşek eşitlikle karşılaştırılıyor.','Metin beklenmeyen bir sayısal değere dönüşebilir.','Girdiyi açıkça dönüştürüp katı eşitlik kullanın.');
    if (performance && ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression &&
      ts.isObjectLiteralExpression(node.initializer.expression) && node.name.getText()==='style') emit(line(),'performance','render-allocation','low','Render sırasında yeni stil nesnesi üretiliyor','JSX style özelliğinde satır içi nesne literalı kullanılıyor.','Memo kullanan alt bileşenlerde her render ayrı referans oluşturabilir.','Profiler ile maliyeti ölçün. Sabit stilleri gerektiğinde bileşen dışına taşıyın.');
    if (!ts.isCallExpression(node)) return;
    const name=ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText();
    if (performance) calls.add(name);
    const closes:Record<string,string>={setInterval:'clearInterval',addEventListener:'removeEventListener',subscribe:'unsubscribe'};
    if (performance && Object.hasOwn(closes,name) && !(name==='addEventListener' && /(?:once\s*:\s*true|signal\s*[:,}])/.test(node.arguments[2]?.getText() ?? ''))) resources.push({line:line(),start:name,stop:closes[name]});
    const first=node.arguments[0], arg=security ? (first?.getText() ?? '') : '';
    if (security && /^(?:fetch|axios|request)$/.test(name) && /(?:req|request)\.(?:body|query|params)\b/.test(arg)) emit(line(),'security','outbound-url','high','Giden isteğin adresi istek girdisinden geliyor','HTTP çağrısının hedef ifadesinde istek verisi kullanılıyor.','İzin verilmeyen hedeflere sunucu üzerinden erişim mümkün olabilir.','Protokolü, çözümlenen adresi ve hedef alan adını izin listesiyle doğrulayın.');
    if (security && /^(?:readFile|readFileSync|sendFile|createReadStream)$/.test(name) && /(?:req|request)\.(?:body|query|params)\b/.test(arg)) emit(line(),'security','path-input','high','Dosya yolunda istek girdisi kullanılıyor','Dosya okuma yolunda doğrudan istek ifadesi var.','Okuma işlemi izinli kökün dışına çıkabilir.','Son gerçek yolu yetkili kök dizin altında doğrulayın.');
    if (security && /^(?:exec|execSync)$/.test(name) && /(?:req|request)\.(?:body|query|params)\b/.test(arg)) emit(line(),'security','shell-input','critical','Kabuk komutu istek verisi kullanıyor','Kabuk çağrısının komut ifadesinde doğrudan istek girdisi bulundu.','Dış girdi çalışan sürecin işlemlerini değiştirebilir.','Kabuğu kaldırıp sabit program ve doğrulanmış bağımsız argümanlar kullanın.');
    if (security && name==='createHash' && first && ts.isStringLiteralLike(first) && /^(?:md5|sha1)$/i.test(first.text)) emit(line(),'security','weak-hash','medium','Zayıf özet algoritması','Çağrı MD5 veya SHA-1 kullanıyor.','Güvenlik doğrulamasında çakışma direnci yetersiz olabilir.','Kullanım amacını doğrulayın. Güvenlik işlemlerinde güncel özet veya parola türetme işlevi kullanın.');
    if (security && ((name==='cors' && (!first || /origin\s*:\s*(?:true|["']\*["'])/.test(arg))) ||
      (name==='setHeader' && first && ts.isStringLiteral(first) && first.text.toLowerCase()==='access-control-allow-origin' && node.arguments[1]?.getText().slice(1,-1)==='*'))) emit(line(),'security','cors','medium','Geniş CORS politikasını inceleyin','CORS ayarı herhangi bir kökene izin veriyor.','Özel yanıtlar istem dışı kökenlerle paylaşılabilir.','Genel erişim gereksinimini doğrulayıp izinli kökenleri sınırlandırın.');
    if ((security || performance) && /^(?:findUnique|findFirst|findById|findOne|query|execute)$/.test(name)) {
      if (performance) for (let p:ts.Node|undefined=node.parent;p && !ts.isFunctionLike(p);p=p.parent) if (ts.isIterationStatement(p,false)) {
        emit(line(),'performance','n-plus-one','medium','Döngü içinde veri sorgusu','Aynı döngü gövdesinde veri erişim çağrısı var.','Girdi sayısıyla birlikte sorgu sayısı artabilir.','Sorgu günlüğünü ölçün. İlişkileri toplu sorgu ile yükleyin.'); break;
      }
      if (performance && first && ts.isStringLiteralLike(first) && /\bLIKE\s+'%/i.test(first.text)) emit(line(),'performance','query-index','low','Ön eki jokerli metin araması','Sorgu LIKE desenine % ile başlıyor.','Normal B-tree indeksi aramayı hızlandıramayabilir.','EXPLAIN planını ve veri hacmini kontrol edin. Uygunsa metin indeksi kullanın.');
      if (security && /req\.params\./.test(arg) && !/userId|ownerId|tenantId/.test(arg)) emit(line(),'security','object-scope','medium','Nesne sorgusunun yetki kapsamını inceleyin','İstek parametresinden gelen kimlikle sorgu yapılıyor.','Sahiplik kontrolü başka katmanda yapılmıyorsa kayıtlar hesaplar arasında açılabilir.','Sorguyu oturumun kullanıcı veya kiracı kapsamıyla sınırlandırın.');
    }
    if (performance && name==='fetch' && node.arguments.length===1 && !/\b(?:AbortController|AbortSignal)\b/.test(file.text)) emit(line(),'performance','request-timeout','low','İstek için zaman sınırını inceleyin','Fetch çağrısı seçenek almıyor ve dosyada iptal sinyali görülmedi.','Bekleyen işlem bağlantı ve iş kapasitesini tutabilir.','İstek bütçesini tanımlayıp iptal sinyali kullanın. Yeniden denemeleri idempotent işlemlerle sınırlandırın.');
    if (bugs && name==='reduce' && node.arguments.length===1 && ts.isPropertyAccessExpression(node.expression) && ts.isArrayLiteralExpression(node.expression.expression) && !node.expression.expression.elements.length) emit(line(),'bugs','empty-reduce','high','Boş dizide başlangıçsız reduce','Boş dizi reduce çağrısına başlangıç değeri verilmemiş.','İfade TypeError oluşturur.','İşleme uygun bir başlangıç değeri sağlayın.');
    if (bugs && /^set[A-Z]/.test(name) && first && ts.isBinaryExpression(first) && ts.isIdentifier(first.left) &&
      name.slice(3).toLowerCase()===first.left.text.toLowerCase()) emit(line(),'bugs','state-update','low','State güncellemesi yakalanan değere bağlı','Setter önceki render değerinden yeni değer hesaplıyor.','Toplu veya asenkron güncellemelerde bir değişiklik kaybolabilir.','Önceki değeri alan fonksiyonel setter kullanmayı değerlendirin.');
    if (errors && name==='then' && ts.isExpressionStatement(node.parent)) emit(line(),'errors','promise-rejection','medium','Promise zincirinin hata yolu görünmüyor','Bağımsız then çağrısının sonucu döndürülmüyor veya beklenmiyor.','Reddedilen işlem çağıranın hata yönetimine ulaşmayabilir.','Zinciri döndürün, await edin veya sonuna bağlama uygun catch ekleyin.');
  });
  for (const r of resources) if (!calls.has(r.stop)) emit(r.line,'performance','lifecycle-'+r.start,'medium','Kaynağın yaşam döngüsünü inceleyin',
    r.start+' çağrısı bulundu. Dosyada '+r.stop+' çağrısı görülmedi.','Tekrarlanan kurulumlar etkin kaynakları biriktirebilir.','Sahipliği takip edip bileşen kapanışında '+r.stop+' veya eşdeğer temizliği doğrulayın.');
}
