# D54 Report — doğruluk, kapsam ve LLM triyajı (A+B+C)

## Amaç
D54 Report başkalarının da kullanacağı açık bir araç olacak (satış yok). Bugünkü
gerçek proje taramasında (tek depoda web+mobil+servisler, ~4.900 bulgu) kritik/yüksek
bulguların ~%95'i yanlış alarmdı, sağlık puanı 0'dı ve en değerli denetim (ana
paketlerin bağımlılık denetimi) hiç çalışmadı. Yeni kullanıcı ilk taramada güven
kaybederse aracı bırakır. Başarı: aynı türden bir projede kritik/yüksek listesi
gerçek işlere iner, puan anlamlı olur, ana paketler denetlenir.

## Hedefler / hedef dışı / başarısızlık sayılanlar
- Hedef: A yanlış alarm azaltma, B kapsam, C isteğe bağlı LLM triyajı.
- Hedef dışı: yeni tarama modülü/kural ailesi, arayüz, satış/lisans.
- Başarısızlık: gerçek bir sızıntıyı (gerçek anahtar, gerçek SQL enjeksiyonu)
  artık kaçırmak; modelsiz kullanımın bozulması; stdout JSON sözleşmesinin kırılması.

## Kısıtlar
- Modelsiz (deterministik) çalışma varsayılan kalır; C yalnız açıkça istenince.
- Mevcut yapı korunur: `src/scanners/*`, `engine.ts`, `reporters/*`, `types.ts`,
  `mcp-server.ts`. Rapor şeması geriye uyumlu değişir (yeni alanlar isteğe bağlı).
- Test örnekleri KURGUSAL yazılır; başka projelerin kodu depoya kopyalanmaz.
- Tam test/derleme yardımcılarda (AGENTS.md kuralı).

## Yaklaşımlar
- A önce doğruluk, B önce kapsam, C LLM ile eleme değerlendirildi. Kullanıcı üçünü
  birden istedi. Sıra: A → B → C (C, A'nın daralttığı listeyi elediği için en ucuz
  orada; B'nin yeni bulguları da A kurallarından geçer).

## A — Doğruluk (PR 1)
1. `security.literal-secret` (`scanners/security.ts` ~26-37):
   - Test/fixture yolları (`*.test.*`, `*-test.*`, `__tests__`, `fixtures`, `tests/`)
     önem düzeyi `low` + "test verisi" notu (gizlenmez, düşer).
   - Herkese açık olduğu bilinen önekler/adlar atlanır: `pk.` (Mapbox), `NEXT_PUBLIC_`,
     `EXPO_PUBLIC_`, `VITE_`, Google OAuth istemci kimliği (`*.apps.googleusercontent.com`).
   - Değer bir yol/rota/etiket/i18n anahtarı gibi görünüyorsa (`/` ile başlar, boşluk
     içerir, yalnız küçük harf-tire) kimlik bilgisi sayılmaz.
   - CI servis konteyneri test şifreleri (`services.*.env` altında, workflow dosyası)
     `low`.
   - Bilinen gerçek biçimler (`knownCredential`: AKIA…, sk-…, -----BEGIN PRIVATE KEY,
     ghp_… vb.) her zaman `high/critical` kalır — kaçırma yok.
   - Servis hesabı JSON'u (`"type":"service_account"` + `private_key`): git'te
     izleniyorsa critical; `.gitignore` ile dışlanmışsa low "yerel dosya".
2. `security.sql-construction` (~69-71): şablondaki her `${}` ifadesi sabit/izinli
   (ör. yalnız `"?"` üreten map/join, sabit tablo/alan adı, koşullu sabit metin) ve
   çağrının ikinci argümanı parametre dizisi ise `low`'a düşer; aksi `high` kalır.
   Belirsizse high (güvenli taraf).
3. Sağlık puanı (`reporters/json.ts`): her önem düzeyinin cezası tavanlı
   (öneri: critical 40, high 30, medium 20, low 10; bulgu başı ağırlık aynı).
   Puan 0 ancak gerçekten çok kritik/yüksek olunca çıkar.
4. Bastırma: hedef kökte `.d54report-ignore` (JSON veya satır başı
   `kural yol[:satır] # gerekçe`). Gerekçesiz satır geçersiz + uyarı. Bastırılanlar
   raporda sayı olarak gösterilir, listeden çıkar, puana girmez.
5. MCP (`mcp-server.ts`): `critical_high` öğelerine `line` eklenir; liste varsayılan
   ilk 25 + `kural→sayı` özeti; tamamı rapor dosyasında. Cevap hedefi < 15k karakter.
6. Rapor klasörü: hedef bir git deposuysa ve `reports/` ignore'da değilse coverage'a
   tek satır uyarı (dosya değiştirilmez).
7. Doğruluk ölçüm seti: `tests/precision/` altında kurgusal dosyalar — her biri
   "beklenen: bulgu yok / low / high" etiketli; testte yanlış alarm ve kaçırma sayılır.
   Gerçek sızıntı örnekleri (sahte ama biçimi gerçek anahtar) kaçırılırsa test kırmızı.

## B — Kapsam (PR 2)
1. Tek depoda çoklu paket (npm workspaces): bugün kök `package.json` bile
   "güvenli denetim girdisi üretilemedi" verdi. İlk iş teşhis (kilit dosyası boyut
   sınırı mı, `workspaces`/`link:true` girdileri mi — `scanners/audit-input.ts:21-44`).
   Hedef: kök kilit dosyasından her çalışma alanı için doğru denetim girdisi; alt
   paketin kendi kilidi yoksa kökünkünü kullan. pnpm/yarn kilidi varsa "desteklenmiyor"
   açıkça yazılır.
2. pip-audit yoksa: `requirements.txt` için OSV sorgusu (npm ile aynı "genel servise
   paket adı gider" uyarısıyla) ya da net "pip-audit kurun" notu — kolay olan.
3. Tip/lint/derleme: zaten izinle çalışıyor; MCP aracına `allow_project_commands`
   parametresi eklenir (varsayılan false), açıklaması net.
4. Büyük dosya sınırına takılan dosyalar coverage'da adıyla listelenir (ilk 10).

## C — LLM triyajı (PR 3)
- Yeni isteğe bağlı adım `--triage` / MCP `triage: true` (yalnız `use_llm` ile).
- Yalnız critical/high bulgular (A'dan sonra az kalır), her biri için dosyadan ±15
  satır bağlam + kural açıklaması mevcut `llm/provider.ts` üzerinden gönderilir.
- Sonuç bulguya eklenir: `triage: { verdict: "gerçek"|"yanlış alarm"|"belirsiz", reason }`.
  Bulgu SİLİNMEZ; markdown'da yanlış alarmlar ayrı bölümde.
- Bütçe tavanı (bulgu sayısı ve toplam token) + kullanılan model raporda.
- Gizli değer içeren satır modele gönderilmeden maskelenir.

## Kararlaştırılanlar (kullanıcı)
- Başkaları da kullanacak, satış yok; kendi projelerinde de kullanılacak.
- A, B, C üçü birden, hızlı.
- GitHub açıklamaları (PR açıklamaları, depo açıklaması) Türkçe + İngilizce iki dilli.

## Benim kararlarım (düzeltilebilir)
- Sıra A→B→C, her biri ayrı PR.
- Test bulguları silinmez, `low`'a düşer.
- Puan tavanları yukarıdaki öneri değerleri.
- Bastırma dosyası adı `.d54report-ignore`, gerekçe zorunlu.

## Yapıcıya kalanlar
- Kural sezgilerinin tam regex'leri, bastırma dosyası ayrıştırıcısı, MCP özet biçimi,
  B1 kök neden düzeltmesi, C istem metni.
