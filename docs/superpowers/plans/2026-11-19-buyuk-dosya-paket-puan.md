# Büyük dosya + paket gruplama + puan tavanı — Uygulama Planı

**Spec:** docs/superpowers/specs/2026-11-19-buyuk-dosya-paket-puan-design.md
**Dal:** feat/kapsam-puan-gruplama · Doğrulama: `npm run typecheck && npm test && npm run build`

## Global kısıtlar
- Yeni bağımlılık yok. Mevcut test düzeni (vitest, `tests/*.test.ts`) kullanılır.
- README'nin TR ve EN bölümleri (satır ~138 "Capped health score", ~220 "1 MiB", ~236-250 "Sağlık puanı" tablosu) yeni değerlerle güncellenir.
- Commit mesajları Türkçe; `git add -A` yok.

## Görev 1 — 4 MiB kaynak sınırı
- `src/source.ts`: `tooLarge` ve `readBoundedFile` içindeki 1_048_576 → `MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024` (dosya başına sabit). `bundlesOnly` eşiği (1_048_576) DEĞİŞMEZ. 48 MiB toplam bütçe aynı.
- Test (`tests/engine.test.ts` ya da yeni `tests/source.test.ts`): geçici dizinde 2 MiB `.ts` dosyası → `snapshot` sonucunda `text` boş değil, notlarda "Boyut sınırı" yok; 5 MiB `.ts` → `text` boş ve not dosya adını içeriyor.

## Görev 2 — paket başına tek uyarı bulgusu
- `src/scanners/tooling.ts` ~306-322: gruplama anahtarı `row.dependency || row.id` (görev dosyası zaten ayrı). Grup için:
  - `severity` = en yüksek (`critical > high > medium > low`).
  - temsilci = en yüksek önemdeki satırların kimlikleri sıralanınca ilki (kimliksiz olabilir).
  - `title` = `['Bağımlılık uyarısı', dependency, temsilci].filter(Boolean).join(' ')` + (benzersiz kimlik sayısı > 1 ise ` (+<kalan>)`).
  - `evidence` = `<label> çıktısında <satır sayısı> eşleşme bulundu.` + kimlik varsa ` Kimlikler: id1, id2, …` (en çok 10, fazlası ` +<n>`).
  - `advice`: gruptaki ilk tanımlı `fixed` ile mevcut metin.
- Test (`tests/static.test.ts` ya da araç testinin bulunduğu dosya; npm audit JSON fikstürüyle): `@xmldom/xmldom` için 2 high + 1 moderate kimlik → tek bulgu, `severity: 'high'`, başlık sıralamada ilk high GHSA'yı ve `(+2)` içerir, kanıt üç kimliği listeler. İki ayrı paket → iki bulgu. Mevcut `tests/fixer.test.ts` değişmeden geçer (gerekirse yalnız fikstür başlık biçimi).

## Görev 3 — puan tavanları
- `src/reporters/json.ts`: `caps = {critical:30, high:20, medium:10, low:5}`.
- Test (`tests/reporters.test.ts`): sayımlar 3/119/357/4577 → `health 35`; bulgusuz → 100; tek kritik → 85; 2 kritik + 1 yüksek → 63.
- README TR+EN tavan değerleri ve "en kötü puan 35" notu.

## Bitiş
Tüm doğrulama komutları PASS → her görev ayrı commit → rapor: commit kimlikleri, değişen satırlar, test çıktısı özeti.
