# Derin inceleme API modu — ölçüm durumu ve sıradaki işler (20 Kas 2026)

Dal: `feat/derin-api-modu` (push yok). Plan: `2026-11-20-derin-inceleme-api-modu.md`.

## Yapılanlar (commit)
| Commit | İş |
|---|---|
| ce515d4 / 9c7dcc4 | API modu (`deep run`, MCP `d54_deep_review_run`), çağrı hatası incelemeyi durdurmaz |
| 659c771 | İnceleme düzeltmeleri: `D54_DEEP_MAX_TOKENS`, kalıcı/3 art arda hatada dur, `D54_MCP_DEEP_MAX_BUDGET`, bütçe ≥2, aday ön süzgeci, metin temizliği |
| 28a559a | Tur 1: parça başına toplu doğrulama, `D54_DEEP_EFFORT`, `--candidates-out` aday günlüğü |
| 21b1e36 | Risk kelimeli arayüz bileşenine -10 ceza yok; parçalar dosyalar arası sırayla (round-robin) |
| 2563d56 | Tur 2: operatör bağlam notu (`--context`, `D54_DEEP_CONTEXT_FILE`, ≤4096 bayt, yalnız sistem istemine) |

Son test: `npm run build && npm test` PASS 192/193 (1 atlanan tarayıcı testi).

## Ölçüm düzeni
- Hedef kod: D54 `8272271c` (worktree `/home/mcp/d54-olcum`; yoksa `git -C /home/mcp/dogadayiz54-kaynak worktree add --detach /home/mcp/d54-olcum 8272271c`).
- Doğruluk listesi: `/home/mcp/d54-gorevler/d54-report-olcum/olcum-dogru.json` (7 hata; satırlar ±15).
- Bağlam notu: `/home/mcp/d54-gorevler/d54-report-olcum/d54-baglam.txt` (yalnız ağ geçidi gerçekleri; bilinen hatalara ipucu YOK — ölçüm hilesi olmasın).
- Komut: `D54_DEEP_EFFORT=medium D54_PROVIDER=anthropic D54_MODEL=claude-opus-5-5 D54_API_KEY=… node dist/cli.js deep run --path /home/mcp/d54-olcum --out <dir> --budget 40 [--context <not>] --candidates-out <dir>/adaylar.json`. Anahtar `~/.d54-claude-api-key` yalnız komut ortamına.

## Sonuçlar (bütçe 40, claude-opus-5-5)
| Ölçüm | Kod | $ | Aday→doğrulanan | Belirsiz | Bilinen 7'den |
|---|---|---|---|---|---|
| 0 | 659c771 | 1,68 | 41→10 (21 doğrulanamadı) | 10 | B7 |
| 1 | 28a559a | 1,86 | 47→24 | 22 | B7, B5 (B6 aday ama belirsiz) |
| 2 | 21b1e36 | 1,56 | 35→25 | 10 | B7, B6 (B5 kayboldu) |
| 3 | 2563d56 + bağlam notu | 1,54 | 20→15 | 5 | hiçbiri doğrulanmadı (B6, B7 aday ama belirsiz) |

ÖLÇÜM-3 (39 çağrı, 226k/31,7k jeton; ilk koşu oturum değişince yarıda kesildi, yeniden koşturuldu): bağlam notu adayı yarıya indirdi (35→20), kritik yanlış alarm kalmadı (0 kritik), ama doğrulayıcı fazla temkinli oldu: önceki üç ölçümde doğrulanan B7 ve ÖLÇÜM-2'de doğrulanan B6 "belirsiz"e düştü. Bağlam notu tek başına kazanç değil; doğrulayıcı parça dışını göremediği sürece not "korunuyor olabilir" şüphesini artırıyor.

## Ajan modu ölçümü — Antigravity keşif + bağımsız doğrulama (API ücreti 0)
Mucip önerisi (20 Kas): keşfi Claude API yerine Antigravity modelleri yapsın.

| Ölçüm | Keşif | Doğrulama | Okunan parça dosyası | Aday→doğrulanan | Ret / belirsiz | Bilinen 7'den |
|---|---|---|---|---|---|---|
| A | Gemini 4 Neon (high), 2 oturum, ~13 dk | 2 Sonnet ajanı, tüm depo erişimli, ~3 dk | 104/104 | 53→38 | 13 / 2 | B1, B3, B6 |
| B | Gemini 4 Carbon (high), 2 oturum, ~20 dk | 1 Sonnet ajanı (yalnız Neon'da olmayan 30 aday), ~4 dk | 104/104 | 58 (28'i Neon'la örtüşük) → yeni 30'dan 22 | 8 / 0 | B1, B3, B6 (aday, Neon'la örtüşük), B7 (doğrulandı) |
| A∪B | iki model birleşimi | | | 83 ayrı aday → 60 doğrulanan | 21 / 2 | 4/7: B1, B3, B6, B7 (B2, B4, B5 ikisinde de yok) |

- Düzen: `deep prepare --max-chunks 200` (oturum `8db006d1462d79e6`) → `claude-agy run --model gemini-4-neon-high` (brif `kesif-brif.md`, yalnız parça dosyaları + bağlam notu) → doğrulayıcılar `/home/mcp/d54-olcum` çalışma ağacını okur, git geçmişi yasak (`dogrulama-brif.md`) → `deep submit`: 38/38 kabul (uydurma satır/alıntı yok). Önem: 14 orta, 24 düşük.
- Carbon kalıcı kopya: `/home/mcp/d54-gorevler/d54-report-olcum/olcum-agy-carbon/` (`carbon-A|B.json`, `carbon-yeni.json`, `karar-carbon.json`). İkinci model +22 doğrulanmış bulgu ve +1 bilinen hata getirdi; örtüşme %48 (28/58).
- Düzeltme: Neon turunun 38 bulgusundan 31'i D54 PR #1490 (fix/derin-inceleme-2); Carbon turunun 22 bulgusu henüz düzeltilmedi.
- Kalıcı kopya: `/home/mcp/d54-gorevler/d54-report-olcum/olcum-agy-neon/` (brifler, `adaylar.json`, `karar-*.json`, `findings.json`, rapor).
- 7 bilinen hatanın hepsi okunan parçalardaydı; B2, B4, B5, B7 kapsamdan değil modelden kaçtı. Neon B1/B3'ü buldu (Opus hiç bulamadı), Opus B5/B7'yi buldu (Neon bulamadı) → modeller birbirini tamamlıyor; ikinci modelle birleşim turu deneniyor (Carbon high).
- Doğrulayıcı tüm depoyu görünce "belirsiz" 2/53'e indi (API modunda 5–22). API modundaki belirsiz yığını parça dışını görememekten.
- Sınır: jeton sayacı yok (abonelik); doğrulayıcı kararlarını ayrıca elle denetlemedim; 22 Kas'ta Google Ultra bitiyor, Antigravity kotası düşebilir.
- Parça dağılımı dengesiz: ~20 bin satırlık `rpc-handlers.ts` 202 bölümün 26'sını alırken `page.tsx` dosyaları 50, `assistant.tsx` 32 alıyor → seçim ağırlığı ayrı iş.

Gözlemler:
- 18087/18906 "oturum yoksa args.userId" kritik bulguları YANLIŞ ALARM: `route.ts` `assertRpcAccess` oturum ister, SELF_SCOPED yollarda `userId` oturumla eşleşmeli.
- UI dosyası (B1-B4) ancak 21b1e36 sonrası okunuyor; B4 okunan parçada (160-185) ama birden çok yere yayıldığı için kaçıyor.
- Asıl darboğaz kurgu: 40 çağrı 200 parçanın ~25'ine yetiyor; parça tek başına inceleniyor (çağıran/ağ geçidi bağlamı yok).

## Sıradaki
1. ÖLÇÜM-3 sonucunu tabloya ekle (bağlam notu yanlış alarmı ve "belirsiz"i azalttı mı?).
2. Fable mimari incelemesi (yalnız plan, kod yok): kapsam/bütçe, çapraz parça bağlamı, çok yere yayılmış hatalar. Aday fikirler: keşif ucuz modelle tüm parçalarda (Haiku 5.5 $0.10/$0.50 ya da Sonnet 5.5 $2/$10), doğrulama güçlü modelle (Opus 5.5 / Fable 5.2 $8/$40); doğrulamaya çağıran/çağrılan kısa bağlam; risk sıralamasında dosya başı ağırlık.
3. Model seçimi ve harcama Mucip onayıyla; her tur aynı ölçüm, fayda yoksa geri al.
4. Kalan turlar: effort taraması, 429/5xx yeniden deneme, yapılandırılmış JSON çıktı.
5. PR → Mucip onayı → merge.
