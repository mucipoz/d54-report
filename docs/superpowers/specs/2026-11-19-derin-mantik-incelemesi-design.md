# Derin mantık ve işlevsellik incelemesi — tasarım

Tarih: 2026-11-19 · Yol haritasının 1. alt projesi (sıra Mucip onaylı: 1 mantık/işlevsellik → 2 mobil tasarım/kullanılabilirlik → 3 onarım → 4 kodlama kuralları → 5 işleyiş akışları) · Yaklaşım onayı: Mucip ("Önerini onaylıyorum", A + B modu)

## Amaç ve neden
Mucip D54 Report'un "kodlama, tasarım, işleyiş, mantık ve işlevsellik hatalarını, güvenlik açıklarını, bug'ları taramasını, raporlamasını, onarabiliyorsa onarmasını" istiyor. Bugün mantık hatalarını yakalayan tek parça `src/llm/review.ts`: en çok 6 dosyanın 48 satırlık iskeletini yalnız güvenlik boyutlarında modele gösteriyor; gerçek fonksiyon gövdesini görmediği için yanlış koşul, sınır hatası, unutulmuş `await` gibi hataları bulamaz. Bu alt proje, riskli kodun gerçek gövdesini modele okutan ve her adayı ikinci bir çağrıyla doğrulayan bir "derin inceleme" ekler.

**Başarı:** Doğadayız 54'te (`apps/web/src/lib/mysql/rpc-handlers.ts`, kayıt/ödeme dosyaları) çalıştırıldığında insanın doğruladığı gerçek mantık hataları bulmak; raporda doğrulanmamış tahmin olmaması.

## Çalışma modları (Mucip kararı, 19 Kas: "ücretsiz yolu önce kuralım")
- **Ajan modu — ÖNCE YAPILIR, ücretsiz:** İncelemeyi D54 Report'u çalıştıran ajan (Claude Code, Codex) kendi aboneliğiyle yapar. D54 Report hazırlar (seçim, parçalama, gizleme), ajan inceler ve doğrular, D54 Report sonucu denetleyip rapora yazar. Kim kullanırsa kendi aboneliği kullanılır; depoda anahtar/hesap yoktur.
- **API modu — İKİNCİ PR:** D54 Report modeli kendisi çağırır (aşağıdaki §3-§4 akışı); kullanıcının kendi `D54_API_KEY`'i gerekir. Ajan modunun doğrulama kodunu paylaşır. Mucip API kullanımına da açık ("apide bayağı paramız var", bakiyeyi kontrol ediyor); Doğadayız 54 saha denemesinde onun anahtarı onayıyla kullanılır.

### Ajan modu akışı
1. MCP `d54_deep_review_prepare({ path, since?, deep_files?, max_chunks? })` → seçim (§1) + parçalama (§2) + gizleme; parçaları `<rapor dizini>/deep/<oturum>/chunk-NN.txt` dosyalarına satır numaralı yazar (her dosya ≤ 12.000 karakter, birden çok küçük parça birleşebilir). Oturum durumu `<rapor dizini>/deep/<oturum>/session.json`: parça kimlikleri, dosya yolu, satır aralığı, gizli satır numaraları, kaynak içerik özeti (sha256). Yanıt: oturum kimliği, parça dosya yolları, kapsam özeti, ajan talimatı (kategoriler, kanıt kuralları, şüpheci doğrulama zorunluluğu, sonuç şeması). Yanıt boyutu küçük tutulur (parçalar yanıtta değil, dosyada).
2. Ajan parça dosyalarını okur, adayları çıkarır, her adayı ayrı bir doğrulamadan geçirir (talimat: ikinci bir yardımcı/model ile, iddiayı çürütmeye çalışarak).
3. MCP `d54_deep_review_submit({ path, session, findings[] })`; her öğe `{category, file, line, quote, title, impact, advice, severity, verdict, reason}`. D54 Report denetler: oturum var ve kaynak özeti hâlâ aynı (dosya değiştiyse o dosyanın öğeleri reddedilir); dosya oturumda; satır parçanın aralığında; satır gizli değil; `quote` (boşluk normalleştirilmiş) o satırda geçiyor; `verdict === 'confirmed'`; kategori listede; metinler ≤ 800 karakter ve sır deseni içermiyor; önem tavanı (§4). Geçenler bulgu olur (§5), en son tarama raporuyla birleştirilip yeni rapor (JSON + Markdown) yazılır; rapor yoksa yalnız derin bulgularla rapor. Yanıt: kabul/ret sayıları ve ret nedenleri, yeni rapor yolları, güncel özet.
4. Ajanın ürettiği `uncertain`/`rejected` sayıları da gönderilebilir; kapsam notuna yazılır.
- Ajan doğrulamasını D54 Report kanıtlayamaz; bulgular "Derin inceleme (ajan)" etiketi taşır ve bulgu kanıtı ile satır denetimi zorunludur.
- CLI karşılığı (MCP'siz ajanlar için): `d54-report deep prepare --path <dir> [--since <ref>]` ve `d54-report deep submit --path <dir> --session <id> --findings <json-dosyası>`; çıktı JSON.

## Hedefler
- **A — tam mod (`--deep-review`):** riskli dosyaları seç, fonksiyon gövdelerini parça parça incelet, adayları doğrulat, yalnız doğrulananları bulgu yap.
- **B — fark modu (`--deep-review --since <git-ref>`):** yalnız `<ref>`'ten bu yana değişen satırlara değen fonksiyonlar.
- CLI ve MCP (`d54_scan_project`: `deep_review: boolean`, `since?: string`) ikisinde de.
- Bütçe sınırlı (çağrı sayısı ve girdi boyutu); bütçe dolunca tarama durmaz, kapsam notu "kısmi" der.

## Hedef dışı
- Onarım (alt proje 3). Bulgular dosya+satır taşıdığı için mevcut onaylı model yaması onlara zaten uygulanabilir; yeni onarım davranışı eklenmez.
- Mobil tasarım, akış testleri, yeni statik kurallar (sonraki alt projeler).
- Mevcut `review.ts` ve `--triage` değişmez.

## Anti-hedefler (çalışsa bile başarısızlık sayılır)
- Satır kanıtı olmayan ya da kodla eşleşmeyen bulgu raporlamak (uydurma).
- Şifre/anahtar benzeri satırları, `.env`, kilit dosyalarını modele göndermek.
- Bütçe sınırı olmadan çağrı yapmak (sürpriz maliyet).
- Saldırı adımı yazmak; yalnız düzeltme önerisi.
- Model yanıtını talimat sanmak (taranan kod modeli yönlendirebilir → kod rastgele sınırlayıcılar arasında veri olarak verilir; triyajdaki yöntem).

## Yaklaşımlar
- **A tam mod + B fark modu, aynı motor — SEÇİLDİ.** İlk taramada tüm riskli kod; sonra PR başına ucuz kontrol.
- Yalnız B: ucuz ama eski hataları görmez.
- Dış kodlama ajanı çağırmak: D54 Report kendi başına çalışmalı; elendi.

## Tasarım
### 1. Dosya seçimi
- Aday: `.ts .tsx .js .jsx .mjs .cjs .py .php .rs` (test/fixture/örnek/dist hariç; `review.ts` ile aynı süzgeç).
- Risk puanı = yol anahtar kelimeleri (auth, login, session, permission, role, admin, payment, odeme, billing, wallet, cuzdan, register, kayit, registration, order, price, fiyat, refund, iade, rpc, handler, route, api, webhook) + son 90 günde değişme sayısı (güvenli git çağrısı: `safeGitArgs`) + satır sayısı (küçük ağırlık).
- En yüksek puanlı **8 dosya** (ayar: `--deep-files <n>`, en çok 20). B modunda seçim = değişen dosyalar.

### 2. Parçalama
- TS/JS: TypeScript AST ile üst düzey fonksiyonlar, sınıf yöntemleri ve nesne değişmezindeki yöntem/ok fonksiyonları (RPC eşleme nesneleri gibi). Her parça = tam gövde + başlangıç satırı.
- 300 satırı aşan fonksiyon 300 satırlık pencerelere bölünür (20 satır örtüşme).
- Diğer diller: 200 satırlık pencere.
- Büyük dosyada (ör. `rpc-handlers.ts`) parçalar risk kelimesi geçen ve uzun olanlar önce olacak şekilde sıralanır.
- Gizleme: triyajdaki `isSensitiveForTriage` desenleriyle eşleşen satırlar `<gizli satır>`; satır numaraları korunur.

> §3, §4 ve §6 API modu içindir (sonraki PR). Ajan modunda aynı kategori, kanıt, önem tavanı ve bulgu biçimi (§5) geçerlidir; bütçe ajanın kendi işidir, `max_chunks` (varsayılan 40) parça sayısını sınırlar.

### 3. Bulma çağrısı
- Bir çağrıda en çok ~12.000 karakter kod (birden çok küçük parça birleştirilebilir), satır numaralı.
- Sistem istemi: yalnız kanıta dayalı mantık/işlevsellik hatası; kategoriler `logic` (yanlış koşul/işleç), `boundary` (sınır/off-by-one/boş liste), `null` (tanımsız/boş değer), `async` (unutulmuş await, sırası bozuk iş, yakalanmayan ret), `race` (yarış, çift işlem, kilit), `authz` (yetki kontrolü eksik/yanlış), `business-rule` (iş kuralı ihlali: ücret, kontenjan, durum geçişi), `error-handling` (yutulan hata, veri kaybı). Türkçe metin. Katı JSON: `{"candidates":[{"category","file","line","quote","title","impact","advice"}]}`; `quote` o satırın birebir kod parçası.
- Doğrulama: `file` gönderilen parçalardan biri, `line` parçanın aralığında, `quote` (boşluk normalleştirilmiş) o satırda geçiyor; değilse aday atılır ve sayılır.

### 4. Doğrulama çağrısı
- Her aday için ayrı çağrı: adayın fonksiyonu (tam parça) + aday metni. Sistem istemi şüpheci: "Bu iddiayı çürütmeye çalış; kod başka yerde güvenceye alınıyor olabilir."
- JSON: `{"verdict":"confirmed|rejected|uncertain","severity":"critical|high|medium|low","reason"}`.
- Yalnız `confirmed` → bulgu. Önem: modelin verdiği, ama `authz` dışındakiler en çok `high`; `critical` yalnız `authz` ve `business-rule` (para/veri kaybı) için.
- `uncertain` ve `rejected` sayıları kapsam notuna yazılır, bulgu olmaz.

### 5. Bulgu biçimi
`category: 'bugs'` (authz için `'security'`), `rule: 'review.deep.<kategori>'`, `title: 'Derin inceleme · <başlık>'`, `file`, `line`, `evidence: 'Satır <n>: <quote, en çok 160 karakter>'`, `impact`, `advice`. Sağlık puanına diğer bulgular gibi girer. Aynı dosya+satır+kategori tekrarı birleşir.

### 6. Bütçe ve dayanıklılık
- Varsayılan en çok **40 model çağrısı** (bulma + doğrulama toplamı; ayar `--deep-budget <n>`, en çok 200). Doğrulamaya bütçenin en az yarısı ayrılır; bulma çağrıları bütçenin yarısını geçemez.
- Yanıt okunamazsa bir kez yeniden denenmez; o parça "okunamadı" sayılır.
- Kapsam notu: seçilen dosyalar, incelenen/atlanan parça sayısı, aday/doğrulanan/çürütülen/belirsiz sayıları, kullanılan çağrı sayısı, "model çağrıları maliyet doğurur" uyarısı.

### 7. Arayüz
- CLI `scan`: `--deep-review`, `--since <ref>` (yalnız `--deep-review` ile), `--deep-files <n>`, `--deep-budget <n>`. Model yapılandırması yoksa ya da `--no-llm` ile birlikte verilirse açık hata (triyajdaki gibi).
- MCP `d54_scan_project`: `deep_review` (varsayılan false; `use_llm` false iken true → hata), `since`, `deep_files`, `deep_budget`; MCP özetinde derin bulgular `critical_high` ve `rule_counts` içinde.
- `--since` değeri git ref doğrulamasından geçer (`^[A-Za-z0-9._/~^-]{1,100}$`, `-` ile başlamaz), çağrı `safeGitArgs` ile.
- Markdown raporunda "Derin inceleme" bölümü (bulgu yoksa kapsam özeti).
- README TR+EN.

### 8. Test
Model sahte sağlayıcı ile (mevcut `provider.test.ts`/triyaj testi düzeni):
- seçim sıralaması (anahtar kelime + git değişimi), B modunda yalnız değişen fonksiyonlar;
- AST parçalama (fonksiyon, yöntem, nesne içi ok fonksiyonu, 300+ satır bölme);
- gizleme (şifre satırı modele gitmez, satır numarası korunur);
- uydurma süzgeci (aralık dışı satır, eşleşmeyen alıntı, bilinmeyen dosya atılır);
- yalnız `confirmed` bulgu olur; önem tavanı;
- bütçe dolunca durur ve not yazar;
- `--since` geçersiz ref ve `--no-llm` birlikteliği hata verir.

Ajan modu testleri: prepare parça dosyaları + session.json üretir, sır satırı dosyaya yazılmaz; submit denetimleri (oturum yok, kaynak değişti, aralık dışı satır, gizli satır, eşleşmeyen alıntı, `confirmed` olmayan, bilinmeyen kategori, önem tavanı) tek tek reddeder; geçerli öğe rapora birleşir ve puan yeniden hesaplanır; oturum dizini rapor dizininin dışına çıkamaz (yol geçişi), oturum kimliği biçimi doğrulanır.

### 9. Saha denemesi
Birleşmeden önce Doğadayız 54'te ajan modu (Claude Code bu oturumda; 8 dosya, en çok 40 parça). Her doğrulanan bulgu elle kontrol edilir; doğru/yanlış oranı PR'a yazılır. Yanlış oranı yüksekse istemler ayarlanır.

## Kurucu kontrolü sonrası kararlar (Claude'un kararları, Mucip düzeltebilir)
1. **Onarım:** derin bulgular bu alt projede "yalnız rapor"dur; `verifyCoverage`'ın `review.*` engeli değişmez. Onarım alt projesi 3'te ele alınır. (Aynı yere not: paket başına gruplama sonrası kısmi npm onarımı `verifyScan` imzası yüzünden reddediliyor — PR #5 yan etkisi.)
2. **Modül seçimi:** `--deep-review` açık bayraktır, `--modules`'tan bağımsız çalışır; bulguları (`bugs`/`security`) modül süzgecine takılmaz. MCP'de `deep_review: true` sağlayıcıyı yükler.
3. **Fark modu:** `git diff --unified=0 -M <ref> --` (çalışma ağacı dahil, commitlenmemiş değişiklikler sayılır); yeni dosya tarafındaki hunk aralıkları; yalnız silinen satırlar sayılmaz; yeniden adlandırma yeni yola eşlenir. `--repo` ile `--since` desteklenmez (açık hata).
4. **Aday fazlası:** doğrulama sırası kategori önceliği (authz, business-rule, race, async, null, logic, boundary, error-handling), sonra bulma sırası. Bütçe yüzünden doğrulanamayanlar ayrı sayaç: "bütçe nedeniyle doğrulanmadı".
5. **Gizleme:** derin incelemede yalnız gerçek sır biçimi gizlenir (PEM, bearer/basic, `sk_live`, uzun anahtar biçimli dize değişmezi, gizli anahtar adına dize atanması). `isAuthorized`, `authUser` gibi tanımlayıcılar gizlenmez. Gizli satır üstüne çıkan aday alıntı eşleşmediği için atılır. Satırlarının %30'undan fazlası gizlenen parça atlanır ve kapsam notuna yazılır.
6. **Yanıt uzunluğu:** `LLMProvider.complete`'e isteğe bağlı `maxTokens` (derin incelemede 8192); mevcut çağrılar etkilenmez. Bulma çağrısı başına en çok 8 aday.
7. **Atlanan büyük dosya:** içeriği okunmamış dosya (4 MiB üstü) seçilirse kapsam notunda "okunamadı" olarak görünür. (4 MiB sınırı PR #5 ile birleşti; `rpc-handlers.ts` artık okunuyor.)

## Kurucuya bırakılanlar
Kod düzeni (yeni modül `src/llm/deep-review.ts` + yardımcıları), istem metinlerinin ifadesi, parça birleştirme algoritması, risk puanı ağırlıkları — yukarıdaki sınırlar içinde.

## Bağımlılık
4 MiB dosya sınırı PR #5 ile birleşti (main 3c55635); uygulama dalı güncel main'den açılır.
