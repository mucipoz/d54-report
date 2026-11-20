# Derin inceleme — API modu (2. PR) uygulama planı

Kaynak tasarım: `docs/superpowers/specs/2026-11-19-derin-mantik-incelemesi-design.md` §3-§8 (onaylı).
Mimari karar: API modu ajan modunun hattını yeniden kullanır — `prepareDeepReview` → (bulma çağrıları) → (doğrulama çağrıları) → `submitDeepReview`. Satır/alıntı/sha/gizli satır/önem tavanı denetimi tek yerde (submit) kalır. Model çağrıları mevcut sağlayıcı soyutlamasından (`LLMProvider`) geçer; yeni SDK bağımlılığı yok (anthropic + openai-compatible ikisi de çalışır).

## 1. Sağlayıcı (src/llm)
- `LLMProvider.complete(system, input, opts?: { maxTokens?: number })`. Varsayılan davranış aynı (3072). Derin çağrılar `maxTokens: 16000` geçer (düşünen modellerde JSON kesilmesin).
- Kullanım sayacı: `readonly usage: { calls: number; inputTokens: number; outputTokens: number }` her iki sağlayıcıda; Anthropic `usage.input_tokens/output_tokens` (+ `cache_read_input_tokens`, `cache_creation_input_tokens` girdiye eklenir), OpenAI-uyumlu `usage.prompt_tokens/completion_tokens`. Alan yoksa 0. Başarısız çağrı da `calls`a sayılır.
- Anthropic yanıtında `stop_reason === 'refusal'` ise açık hata (`Model isteği reddetti.`); `max_tokens` ise `Model yanıtı kesildi.`
- Mevcut triyaj ve review çağrıları değişmez (opts verilmez).

## 2. src/deep/api.ts — `runDeepReviewApi(root, out, provider, o: { since?; files?; budget? })`
1. `prepareDeepReview(root, out, { since, files, maxChunks: 200 })` → oturum + parça dosyaları.
2. Bütçe `budget` (varsayılan 40, 1..200): bulma çağrıları en çok `floor(budget/2)`; kalan doğrulama. Parça dosyası sayısı bulma payını aşarsa fazlası atlanır (not: "N parça bütçe nedeniyle incelenmedi").
3. Bulma: her parça dosyası (≤12.000 karakter) rastgele sınırlayıcılar içinde VERİ olarak gönderilir (triyajdaki `makeDelimiters` yöntemi; kod içi metin talimat değildir). Sistem istemi §3 (Türkçe, kanıta dayalı, 8 kategori, katı JSON `{"candidates":[{category,file,line,quote,title,impact,advice}]}`). JSON ayrıştırılamazsa parça "okunamadı" sayılır, yeniden denenmez. Aday ön süzgeci: dosya bu parça dosyasının başlıklarında, satır o başlık aralığında; değilse atılır ve sayılır.
4. Doğrulama: aday başına AYRI çağrı (bütçe biterse kalan adaylar "doğrulanmadı" sayılır): adayın parça metni + aday JSON'u, şüpheci sistem istemi §4 ("çürütmeye çalış; başka katmanda korunuyor olabilir"). JSON `{"verdict":"confirmed|rejected|uncertain","severity":"critical|high|medium|low","reason"}`.
5. `confirmed` adaylar `submitDeepReview(root, out, session, findings, {uncertain, rejected}, { source: 'api', model, usage })` ile birleşir.
6. Dönüş: submit sonucu + `{ calls, inputTokens, outputTokens, model, candidates, confirmed, rejected, uncertain, unreadable, unverified }`.

## 3. submit.ts
- İsteğe bağlı 6. parametre `meta?: { source?: 'agent' | 'api'; model?: string; usage?: {...} }`. Etiket: ajan → `Derin inceleme (ajan) · …` (aynen), api → `Derin inceleme · …`. Kapsam notu api için: `Derin inceleme (API, <model>): X kabul, Y ret; aday A, çürütülen R, belirsiz U, okunamayan parça K; N model çağrısı, giriş/çıkış T1/T2 jeton. Model çağrıları maliyet doğurur.` Ajan modunun notu değişmez.

## 4. Arayüz
- CLI: `deep run --path <dir> [--since <ref>] [--files <n>] [--budget <n>] [--config <file>] [--out <dir>]`. Model yapılandırması yoksa açık hata ("Derin inceleme API modu için D54_PROVIDER/D54_MODEL/D54_API_KEY gerekir."). Çıktı JSON (submit çıktısı + kullanım).
- MCP: `d54_deep_review_run({ path, since?, files?, budget? })` (aynı fonksiyon; yanıt kısa özet + rapor yolları + kullanım).
- `scan --deep-review` bu PR'da YOK (sonraki iş; README'de "deep run" anlatılır).
- README TR+EN: "Derin inceleme — API modu" bölümü, maliyet uyarısı.

## 5. Test (sahte sağlayıcı, ağ yok)
- Kullanım sayacı: anthropic ve openai-compatible yanıtlarından jetonlar toplanır (fetch taklidi).
- Bütçe: budget 6 → en çok 3 bulma çağrısı; doğrulama kalan bütçeyle sınırlı; aşan adaylar `unverified`.
- Akış: sahte sağlayıcı 1 aday döndürür → doğrulama confirmed → rapora `Derin inceleme · ` başlıklı bulgu; rejected/uncertain bulgu olmaz, sayılarda görünür.
- Bozuk JSON → okunamadı; yanlış satır/dosya adayı → atılır (submit'e gitmez ya da submit reddeder).
- Enjeksiyon: parça metninde "ignore previous instructions" geçse bile istem yapısı sınırlayıcıyla sarılı (sistem istemi metni sınırlayıcı içermiyor).
- Ajan modu notu ve başlığı değişmedi (regresyon).
