# Büyük dosya, paket uyarısı gruplama, puan tavanı — kısa tasarım

Tarih: 2026-11-19 · Onay: Mucip ("Önerini kabul ediyorum")

## Neden
Doğadayız 54 taraması (main 7b193982) üç zayıflık gösterdi:
1. `apps/web/src/lib/mysql/rpc-handlers.ts` (1,07 MB) dosya başı 1 MiB sınırı yüzünden hiç okunmadı; arka ucun ana dosyası taranmıyor.
2. npm uyarıları kimlik başına ayrı bulgu (108 kritik/yüksek); aynı paketin 13 uyarısı 13 bulgu.
3. Tavanların toplamı 100 (40+30+20+10) → orta büyüklükte her proje 0 puan; puan bilgi vermiyor.

## Kararlar
1. Kaynak dosya içerik sınırı 1 MiB → **4 MiB**; toplam 48 MiB bütçe ve diğer sınırlar (paket/bundle eşiği, manifest okuma) aynı.
2. npm (ve aynı yoldaki cargo/pip/composer) uyarıları **görev dosyası + bağımlılık başına tek bulgu**: önem = en yüksek; başlıkta temsilci kimlik (en yüksek önemdeki kimliklerden sıralamada ilki) + kalan sayı; kanıtta tüm kimlikler (en çok 10 + kalan sayı); düzeltilmiş sürüm varsa danışmada. Bağımlılık adı yoksa eski davranış (kimlik başına).
3. Tavanlar **kritik 30, yüksek 20, orta 10, düşük 5** (ağırlıklar aynı: 15/7/3/1) → en kötü puan 35.

## Yaklaşımlar
- Büyük dosya: (a) sınırı yükseltmek — seçildi, kurallar satır tabanlı, bütçe zaten var; (b) parça parça okuma — gereksiz karmaşık.
- Gruplama: (a) paket başına — seçildi; (b) kimlik başına + raporda gruplama — sayım/puan yine şişer.
- Puan: (a) tavan düşürme — seçildi; (b) logaritmik ölçek — açıklaması zor.

## Kapsam dışı
SQL tanımlayıcı yanlış alarmları ve CI servis şifresi: `.d54ignore` ile bastırılır, kural değişmez.

## Kısıt
Düzeltici (`deterministic-fixer.ts` npmFix) başlıktaki ilk GHSA/CVE ve bulgu önemini (`severity/kimlik`) doğrular → temsilci kimliğin önemi bulgu önemiyle aynı olmalı.
