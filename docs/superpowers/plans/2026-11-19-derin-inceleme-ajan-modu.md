# Derin İnceleme — Ajan Modu (PR 1) Uygulama Planı

> Uygulayıcı: görev görev, her görevde önce test (kırmızı), sonra kod, sonra yeşil, sonra commit.

**Goal:** D54 Report riskli kodu parçalayıp ajana versin; ajanın doğruladığı mantık hatalarını denetleyip rapora yazsın (model çağrısı yok, ücretsiz).
**Spec:** docs/superpowers/specs/2026-11-19-derin-mantik-incelemesi-design.md ("Ajan modu akışı", §1, §2, §5, "Kurucu kontrolü sonrası kararlar")
**Tech:** TypeScript (ESM), `typescript` AST (zaten bağımlılık), zod (MCP), vitest. Yeni bağımlılık YOK.
**Doğrulama komutu:** `npm run typecheck && npm test && npm run build`

## Global Constraints
- Kategoriler (sabit dizi `deepCategories`): `authz, business-rule, race, async, null, logic, boundary, error-handling` (bu sıra = doğrulama/öncelik sırası).
- Bulgu: `category` = `authz` ise `'security'`, değilse `'bugs'`; `rule` = `'review.deep.' + kategori`; `title` = `'Derin inceleme (ajan) · ' + başlık`; `evidence` = `'Satır ' + line + ': ' + quote` (quote en çok 160 karakter, fazlası `…`); `file`, `line`, `impact`, `advice` ajandan.
- Önem tavanı: `critical` yalnız `authz` ve `business-rule`; diğerlerinde `critical` → `high`'a indirilir. Geçerli değerler `critical|high|medium|low`.
- Metin alanları (`title`, `impact`, `advice`, `reason`) boş olmayan, ≤ 800 karakter ve `src/llm/review.ts` `sensitive` desenine uymayan; değilse öğe reddedilir.
- Parça dosyası en çok 12.000 karakter; varsayılan dosya sayısı 8 (en çok 20), varsayılan parça üst sınırı 40 (en çok 200).
- Oturum kimliği `^[a-f0-9]{16}$` (randomBytes(8) hex); oturum dizini `<out>/deep/<id>/` ve `realpath` ile `<out>` içinde kalmalı.
- `--since` ref: `^[A-Za-z0-9._/~^-]{1,100}$` ve `-` ile başlamaz; git çağrıları `safeGitArgs` + `repositoryEnv()` (src/git-state.ts).
- Commit mesajları Türkçe; `git add -A` yok; push yok.

## Review Focus
1. Ajan uydurma satır/alıntı gönderir → reddedilmeli (aralık dışı satır, gizli satır, alıntı o satırda yok).
2. Prepare ile submit arasında kaynak dosya değişti → o dosyanın öğeleri "kaynak değişti" ile reddedilmeli.
3. Sır içeren satır parça dosyasına yazılmamalı (`<gizli satır>`), satır numarası korunmalı.
4. Oturum kimliğiyle yol geçişi (`../`) denemesi → hata.
5. 1 MB+ dosyada (rpc-handlers.ts benzeri, binlerce fonksiyon) prepare makul sürede biter ve parça sınırına uyar.

---

### Task 1: Dosya seçimi ve fark aralıkları
**Files:** Create `src/deep/select.ts`, Test `tests/deep-select.test.ts`
**Produces:**
- `riskScore(path: string, lines: number, recentChanges: number): number`
- `selectFiles(files: readonly SourceFile[], root: string, o: { limit: number; since?: string }): Promise<{ selected: SourceFile[]; changed?: Map<string, Array<[number, number]>>; notes: string[] }>`
- `validRef(ref: string): boolean`
**Kurallar:** aday uzantılar `.ts .tsx .js .jsx .mjs .cjs .py .php .rs`; `isTestPath` ve `fixtures?|examples?|dist|build` yolları hariç; içeriği boş (okunmamış) dosya seçilirse not `"<yol> içeriği okunamadı (boyut sınırı)"`. Anahtar kelimeler (yol, küçük harf, her biri +10): auth, login, session, permission, role, admin, payment, odeme, billing, wallet, cuzdan, register, kayit, registration, order, price, fiyat, refund, iade, rpc, handler, route, api, webhook. Son 90 gün değişim (+2 her commit, en çok +20): `git log --since=90.days --name-only --format= -- .`; satır sayısı +min(10, satır/500). Git yoksa değişim 0, not yazılmaz. `since` verilirse: `git diff --unified=0 -M <ref> --`; yeni taraf hunk aralıkları `changed` içine; seçim = değişen ve aday uzantılı dosyalar (limit uygulanır, puana göre).
**Tests:** `rpc-handlers.ts` + `utils.ts` + `auth/login.ts` → sıra login, rpc-handlers, utils; limit 2 → 2 dosya; test yolu seçilmez; `validRef('-x')`, `validRef('a;b')` false, `validRef('origin/main~2')` true; geçici git deposunda bir commit sonrası değişen satırlar `changed`'de doğru aralıkla.

### Task 2: Parçalama ve gizleme
**Files:** Create `src/deep/chunk.ts`, Test `tests/deep-chunk.test.ts`
**Produces:**
- `interface Chunk { file: string; start: number; end: number; name: string }`
- `deepSensitive(line: string): boolean` — yalnız gerçek sır biçimi: PEM başlığı, `bearer|basic` + uzun belirteç, `sk_(live|test)_`, ≥ 24 karakterlik anahtar biçimli dize değişmezi (`['"][A-Za-z0-9+/=_-]{24,}['"]`), adı `pass|pwd|secret|token|api_?key|credential` içeren değişkene dize değişmezi atanması. `isAuthorized`, `authUser`, `requireAuth(` gizlenmez.
- `chunkFile(file: SourceFile, changed?: Array<[number, number]>): Chunk[]` — TS/JS: `typescript` ile üst düzey fonksiyon, sınıf yöntemi, nesne değişmezi içindeki yöntem/ok/fonksiyon özellikleri (iç içe fonksiyonlar dışarıdakinin parçasıdır); > 300 satır → 300'lük pencere, 20 örtüşme; `changed` verilirse yalnız aralıkla kesişen parçalar. Diğer diller: 200 satırlık pencere. Sıralama: adında/gövdesinde risk anahtar kelimesi geçen, sonra uzun olan önce.
- `renderChunks(file: SourceFile, chunks: Chunk[], maxChars: number): { text: string; masked: number[]; used: Chunk[] }[]` — `"<satır no>| <kod>"` biçimi, gizli satır `"<satır no>| <gizli satır>"`; başlık `### <file> · <name> · <start>-<end>`; gizli satır oranı > %30 olan parça atlanır (ayrı sayaç).
**Tests:** fonksiyon/yöntem/nesne-içi ok fonksiyonu ayrı parça; 700 satırlık fonksiyon 3 pencere; `const apiKey = "sk_live_…"` gizli, `if (!isAuthorized(user))` görünür, satır numarası korunur; `changed` süzgeci; 12.000 karakter sınırı.

### Task 3: Hazırlama (oturum)
**Files:** Create `src/deep/session.ts`, Test `tests/deep-session.test.ts`
**Produces:**
- `interface DeepSession { id: string; root: string; createdAt: string; files: { path: string; sha256: string }[]; chunks: (Chunk & { masked: number[] })[] }`
- `prepareDeepReview(root: string, out: string, o: { since?: string; files?: number; maxChunks?: number }): Promise<{ session: string; chunkFiles: string[]; summary: { files: string[]; chunks: number; skippedMasked: number; notes: string[] }; instructions: string }>`
- `loadSession(out: string, id: string): Promise<DeepSession>`
**Kurallar:** `snapshot` (src/source.ts) ile dosyalar; `selectFiles` → `chunkFile` → `renderChunks`; `<out>/deep/<id>/chunk-01.txt …` (`mode 0o600`, `flag 'wx'`), `session.json`. `ensureOutputDirectory`. `instructions` (Türkçe, sabit metin): kategoriler ve anlamları; yalnız kanıta dayalı; `quote` satırdaki birebir kod; her aday ayrı bir yardımcı/model ile çürütülmeye çalışılmalı; yalnız `confirmed` gönder; sonuç şeması (Task 4 alanları); saldırı adımı yazma.
**Tests:** dosyalar ve session.json oluşur; sır satırı hiçbir chunk dosyasında geçmez; `loadSession(out, '../x')` hata; olmayan oturum hata.

### Task 4: Gönderim denetimi ve rapora birleştirme
**Files:** Create `src/deep/submit.ts`, Create `src/reporters/write.ts` (engine'deki md+json yazma bloğunu fonksiyona taşı: `writeReport(out: string, report: Report): Promise<string>` → prefix; engine bunu kullanır, davranış aynı), Test `tests/deep-submit.test.ts`
**Produces:**
- `deepFindingSchema` (zod): `{ category: enum(deepCategories), file, line: int>0, quote: string 1..400, title, impact, advice, severity: enum, verdict: enum('confirmed','rejected','uncertain'), reason }`
- `submitDeepReview(root: string, out: string, id: string, findings: unknown[], counts?: { uncertain?: number; rejected?: number }): Promise<{ accepted: number; rejected: { index: number; reason: string }[]; report: Report; prefix: string }>`
**Kurallar:** her öğe sırayla: şema → `verdict==='confirmed'` → dosya oturumda → güncel sha256 aynı ("kaynak değişti") → satır bir parçanın aralığında → satır gizli değil → boşluk normalleştirilmiş `quote` güncel dosyanın o satırında geçer → metin kuralları → önem tavanı. Ret nedenleri Türkçe kısa sabit metinler. Aynı dosya+satır+kategori tekrar edilirse ilki kalır. Rapor: `<out>` içindeki en yeni `d54-report-*.json` (`readReport`, `target.root` = realpath(root) olanlar) bulguları `Issue`'ya çevrilir (`id`, `triage` atılır) + kabul edilenler → `makeReport(target, stack, filesScanned, issues, coverage + deep notları)`; rapor yoksa `target={project: basename(root), root}`, `stack=[]`, `filesScanned=0`. Kapsam notu: `Derin inceleme (ajan): <n> kabul, <m> ret, ajan bildirimi <u> belirsiz / <r> çürütülen.` + `Ajan doğrulamasını D54 Report kanıtlayamaz; satır ve alıntı denetimi yapıldı.`
**Tests:** her ret nedeni için bir öğe (şema, confirmed olmayan, bilinmeyen dosya, kaynak değişti, aralık dışı, gizli satır, alıntı eşleşmiyor, uzun metin, sır deseni); `critical` `logic` → `high`; geçerli öğe raporda `review.deep.logic` ve puan yeniden hesaplanır; önceki raporun bulguları korunur; engine testleri değişmeden geçer.

### Task 5: MCP araçları, CLI, README
**Files:** Modify `src/mcp-server.ts`, `src/cli.ts`, `README.md` (TR + EN), Test `tests/mcp.test.ts` (mevcut düzende), `tests/engine.test.ts` gerekirse
**Produces:**
- MCP `d54_deep_review_prepare` — input `{ path, since?, deep_files?: int 1..20, max_chunks?: int 1..200 }`; out dizini `d54_scan_project` ile aynı (`<path>/reports`); çıktı `{ session, chunk_files, summary, instructions }` (`structured`).
- MCP `d54_deep_review_submit` — input `{ path, session, findings: array (en çok 200), uncertain?: int, rejected?: int }`; çıktı `{ accepted, rejected: [{index, reason}], summary, report_paths: {markdown, json} }`.
- CLI `d54-report deep prepare --path <dir> [--since <ref>] [--files <n>] [--max-chunks <n>] [--out <dir>]` ve `d54-report deep submit --path <dir> --session <id> --findings <json> [--out <dir>]`; çıktı JSON (stdout).
- README: "Derin inceleme (ajan modu)" bölümü TR + EN: ücretsiz, ajanın aboneliği kullanılır, akış, denetimler, sınırlar ("ajan doğrulamasını kanıtlayamaz"), API modunun sonraki sürümde geleceği.
**Tests:** MCP iki aracın listede olduğu ve geçersiz oturum kimliğinde hata döndüğü; CLI `deep prepare` JSON çıktısı `session` içerir.

## Bitiş
Her görev ayrı commit; tüm doğrulama PASS; rapor: commit kimlikleri, değişen dosyalar, test özeti, bilinen sınırlar.
