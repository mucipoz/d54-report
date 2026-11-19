# D54 Report — Doğruluk, Kapsam, LLM Triyajı Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kritik/yüksek yanlış alarmları kesmek, tek depoda çoklu paket denetimini çalıştırmak ve isteğe bağlı LLM triyajı eklemek.

**Architecture:** Mevcut kural dosyaları (`src/scanners/security.ts`) daraltılır; git durumu ve bastırma iki küçük yeni modülde (`src/git-state.ts`, `src/suppress.ts`) yaşar ve `engine.ts` içinde rapor oluşturulmadan hemen önce uygulanır. Triyaj `src/llm/triage.ts` içinde mevcut `LLMProvider` arayüzünü kullanır. Rapor şeması yalnız isteğe bağlı alanlarla büyür.

**Tech Stack:** TypeScript (ESM, `tsc`), vitest, `typescript` AST, zod, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-11-19-dogruluk-kapsam-triaj-design.md`

## Global Constraints

- Modelsiz çalışma varsayılan kalır; triyaj yalnız `use_llm` + `triage` birlikte verilince çalışır.
- stdout JSON sözleşmesi bozulmaz; yeni alanlar isteğe bağlı (`schemaVersion: 1` kalır).
- `knownCredential` eşleşmeleri (AKIA…, gh[pousr]_…, xox…, PRIVATE KEY) önem düzeyi hiçbir sezgiyle düşürülmez (yalnız kullanıcı `.d54report-ignore` ile bastırabilir).
- Test örnekleri kurgusal; başka projelerden kod kopyalanmaz. Gerçek biçimli sahte anahtarlar parçalanarak kurulur (mevcut testteki `['a','b'].reverse().join()` yöntemi) ki depo tarayıcıları tetiklenmesin.
- Kullanıcıya görünen metinler Türkçe (mevcut üslup). PR açıklamaları ve depo açıklaması Türkçe + İngilizce.
- Doğrulama: `npm run typecheck` ve `npx vitest run <dosya>`; tam `npm test` her PR sonunda.

## Review Focus

1. Gerçek bir anahtar test olmayan dosyada, `NEXT_PUBLIC_` olmayan adla duruyor → yine `high`. (Task A1 testi `keeps real looking secret in app code high`)
2. Test dosyasında gerçek biçimli anahtar (`knownCredential`) → yine `high` (testte de sızıntı sızıntıdır). (Task A1 testi `known credential in test file stays high`)
3. SQL şablonunda `?` parametreleri var ama bir `${}` dış değişken (ör. `${req.query.sort}`) → `high` kalır. (Task A3 testi `dynamic identifier keeps high`)
4. `.d54report-ignore` gerekçesiz satır veya bozuk desen → tarama düşmez, satır yok sayılır, coverage'a uyarı. (Task A5 testi `invalid ignore line is reported not fatal`)
5. Git deposu olmayan hedef / `git` yok → git-state `undefined` döner, servis hesabı `high` kalır, rapor klasörü uyarısı yazılmaz, tarama sürer. (Task A2 testi `non git root degrades`)

---

## PR 1 — Doğruluk (dal `feat/dogruluk`, `tasarim/dogruluk-kapsam` üzerinden)

### Task A1: Şifre kuralını daralt

**Files:**
- Modify: `src/scanners/security.ts:6-37` (`credentialName`, `sample`, `literalCredential`, `secret`)
- Test: `tests/precision.test.ts` (yeni; A7 burayı genişletir)

**Interfaces:**
- Produces: `export function isTestPath(path: string): boolean` in `src/scanners/static-utils.ts` (A7 ve C1 kullanır). Eşleşme: `/(?:^|\/)(?:tests?|__tests__|fixtures?|e2e)\//i` veya ad `/[.-](?:test|spec)\.[cm]?[jt]sx?$/i` veya `/-test\.[cm]?js$/i`.
- Produces: `export function maskSecrets(line: string): string` in `src/scanners/security.ts` (C1 kullanır): `knownCredential` eşleşmesini ve `literalCredential` sayılan değeri `<gizli>` ile değiştirir.

- [ ] **Step 1: Failing testler** (`tests/precision.test.ts`, `describe('şifre kuralı')`):
  - `ignores public prefixes`: `NEXT_PUBLIC_API_KEY=abcdef123456` (`.env.production`), `"mapboxPublicToken": "pk.` + 20 harf + `"` (`app.json`), `EXPO_PUBLIC_TOKEN=...`, `VITE_API_KEY=...`, `clientId: "123-abc.apps.googleusercontent.com"` → `literal-secret` yok.
  - `ignores route and label values`: `{ "/reset-password": "Şifre Sıfırlama" }`, `token: "users.verifyEmailToken"`, `password: "Şifremi unuttum"` → yok.
  - `downgrades test files`: `scripts/foo-test.cjs` içinde `const password = "hunter2hunter2"` → `literal-secret` `low`.
  - `ci service password low`: `.github/workflows/ci.yml` içinde `services:` altında `MARIADB_ROOT_PASSWORD: integration-only` → `low`.
  - `keeps real looking secret in app code high`: `src/config.ts` `const apiKey = "Zx9..."` (16+ karışık karakter) → `high`.
  - `known credential in test file stays high`: `tests/a.test.ts` içinde parçalı kurulmuş `AKIA` + 16 karakter → `high`.
- [ ] **Step 2:** `npx vitest run tests/precision.test.ts` → FAIL.
- [ ] **Step 3: Uygula.** Kurallar: ad `/^(?:NEXT_PUBLIC_|EXPO_PUBLIC_|VITE_|PUBLIC_)/i` veya ad `/public/i` ise atla; değer `pk.` ile başlıyor ya da `.apps.googleusercontent.com` ile bitiyorsa atla; değer `/` ile başlıyor, boşluk içeriyor, ya da `/^[a-z][\w]*(?:\.[a-zA-Z]\w*)+$/` (nokta yolu) ise atla. `isTestPath` → `low`. Workflow dosyasında (`/\.github\/workflows\//`) `services:` bloğu altındaki satır → `low`. `knownCredential` her durumda `high`.
- [ ] **Step 4:** Aynı komut + `npx vitest run tests/static.test.ts` → PASS (mevcut `gizli ayar değerini rapora eklemez` testi geçmeli).
- [ ] **Step 5:** Commit `fix(security): şifre kuralında açık önekleri, rota etiketlerini ve test verisini ayır`.

### Task A2: Git durumu + servis hesabı dosyası

**Files:**
- Create: `src/git-state.ts`
- Modify: `src/scanners/security.ts` (yeni kural), `src/engine.ts:33-58` (`collectStatic` sonrası önem düzeltmesi)
- Test: `tests/precision.test.ts` (`describe('git durumu')`, geçici dizinde `git init`)

**Interfaces:**
- Produces: `export async function gitState(root: string): Promise<{ tracked: Set<string>; isIgnored(path: string): Promise<boolean> } | undefined>` — `execFile('git', ['ls-files','-z'], {cwd:root})`; git yoksa/depo değilse `undefined`. Kabuk kullanma.
- Produces: kural `security.service-account-key` (`high`): JSON dosyasında `"type": "service_account"` ve `"private_key"` birlikte. Evidence değer içermez.
- engine: `gitState` varsa → izlenen dosyadaki `service-account-key` `critical`; izlenmeyen (ignore'lu) → `low` + evidence "Yerel dosya, git'e girmemiş."

- [ ] **Step 1: Failing testler:** `tracked key is critical` (dosya `git add` edilmiş), `ignored key is low` (`.gitignore`'da), `non git root degrades` (git deposu değil → `high`, hata yok).
- [ ] **Step 2:** FAIL doğrula.
- [ ] **Step 3:** Uygula. Servis hesabı dosyası için `literal-secret` aynı satırda ikinci kez üretilmesin (tek kural).
- [ ] **Step 4:** PASS doğrula.
- [ ] **Step 5:** Commit `feat(security): servis hesabı anahtarını git durumuna göre derecelendir`.

### Task A3: SQL kuralını daralt

**Files:**
- Modify: `src/scanners/security.ts:66-73`
- Test: `tests/precision.test.ts` (`describe('sql kuralı')`)

**Interfaces:**
- Produces: `function safeSqlSpan(expr: ts.Expression): boolean` (yerel). Güvenli sayılan `${}` içerikleri: string/number literal; yalnız string literal dalları olan koşullu ifade (`a ? " WHERE x = ?" : ""`); `.map(() => "?").join(...)`; `.map(f => \`\\\`${f}\\\`\`).join(...)` gibi sabit diziden türeyen ad listesi — belirsizse güvenli DEĞİL.

- [ ] **Step 1: Failing testler:**
  - `parameterized conditional is low`: `` query(`SELECT * FROM t${id ? " WHERE id = ?" : ""}`, [id]) `` → `sql-construction` `low`.
  - `placeholder list is low`: `` query(`INSERT INTO t (a) VALUES (${xs.map(() => "?").join(", ")})`, xs) `` → `low`.
  - `dynamic identifier keeps high`: `` query(`SELECT * FROM t ORDER BY ${req.query.sort}`, []) `` → `high`.
  - `string concat keeps high`: `query("SELECT * FROM t WHERE a = '" + name + "'")` → `high`.
- [ ] **Step 2:** FAIL. **Step 3:** Uygula: tüm span'ler `safeSqlSpan` ve ikinci argüman dizi/tanımlayıcı ise `low`, aksi `high`. **Step 4:** PASS.
- [ ] **Step 5:** Commit `fix(security): parametreli SQL şablonlarını düşük öneme indir`.

### Task A4: Tavanlı sağlık puanı

**Files:**
- Modify: `src/reporters/json.ts:4,20-22`
- Test: `tests/reporters.test.ts`

**Interfaces:**
- `const caps = {critical:40, high:30, medium:20, low:10}`; `penalty = Σ min(caps[s], counts[s]*weights[s])`; `weights` aynı kalır.

- [ ] **Step 1: Failing testler:** `5000 low only → health 90`; `1 critical + 146 high + 298 medium + 4447 low → health 25` (100-15-30-20-10); `2 high → 86`; `3 critical → 60`.
- [ ] **Step 2-4:** FAIL → uygula → PASS.
- [ ] **Step 5:** Commit `fix(report): sağlık puanında önem düzeyi başına ceza tavanı`.

### Task A5: `.d54report-ignore` bastırma

**Files:**
- Create: `src/suppress.ts`
- Modify: `src/engine.ts:162` (makeReport çağrısından önce), `src/types.ts` (`Report.suppressed?: number`), `src/reporters/markdown.ts` (özet satırına "Bastırılan · N"), `src/reporters/read.ts` (şemaya `suppressed` isteğe bağlı)
- Test: `tests/engine.test.ts` veya yeni `tests/suppress.test.ts`

**Interfaces:**
- Produces: `export async function loadSuppressions(root: string): Promise<{ rules: Suppression[]; notes: string[] }>`; `export function applySuppressions(issues: Issue[], rules: Suppression[]): { kept: Issue[]; suppressed: number }`.
- `type Suppression = { rule: string; path: string; line?: number; reason: string }`. Satır biçimi: `<kural|*> <yol-glob>[:<satır>] # <gerekçe>`; `#` sonrası boşsa geçersiz. Yol glob yalnız `*` ve `**` destekler. Dosya `readBoundedFile` ile en çok 256 KiB.
- `knownCredential` kaynaklı `literal-secret` bastırılabilir (kullanıcı kararı), ama markdown'da "Bastırılan gerçek biçimli anahtar · N" ayrıca yazılır.

- [ ] **Step 1: Failing testler:** `suppresses matching rule and path`, `line specific suppression`, `invalid ignore line is reported not fatal` (gerekçesiz satır → notes'ta `".d54report-ignore:3 gerekçe yok, yok sayıldı"`), `suppressed excluded from health`.
- [ ] **Step 2-4:** FAIL → uygula → PASS.
- [ ] **Step 5:** Commit `feat: gerekçeli .d54report-ignore bastırma dosyası`.

### Task A6: Kısa MCP özeti + rapor klasörü uyarısı

**Files:**
- Modify: `src/mcp-server.ts:47-61`, `src/engine.ts` (coverage notu)
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Consumes: `gitState` (A2).
- `d54_scan_project` çıktısı: `critical_high` en çok 25 öğe (önem sonra kural sırası), `critical_high_total: number`, `rule_counts: Record<string, number>` (yalnız critical/high/medium kuralları). `evidence/impact/advice` 200 karakterde kesilir (`…`).
- engine: `gitState` var ve `isIgnored('reports/x')` false ise coverage'a: `"reports/ klasörü git tarafından dışlanmıyor. .gitignore'a 'reports/' ekleyin."`

- [ ] **Step 1: Failing testler:** `limits critical_high to 25 and reports total`, `json result under 15000 chars for 200 high findings`, `warns when reports dir not ignored`.
- [ ] **Step 2-4:** FAIL → uygula → PASS.
- [ ] **Step 5:** Commit `feat(mcp): kısa tarama özeti ve rapor klasörü uyarısı`.

### Task A7: Doğruluk ölçüm seti

**Files:**
- Create: `tests/precision/fixture/` (kurgusal mini depo: `apps/web/src/lib/pages.ts`, `apps/web/.env.production`, `apps/mobile/app.json`, `scripts/odeme-test.cjs`, `.github/workflows/ci.yml`, `src/db.ts` parametreli + bir gerçek enjeksiyon, `src/keys.ts` bir gerçek biçimli anahtar), `tests/precision/expected.json` (`[{file, rule, severity}]` — yalnız beklenen critical/high)
- Modify: `tests/precision.test.ts` (`describe('ölçüm seti')`)

- [ ] **Step 1:** Test `fixture critical/high equals expected`: `staticAudit(fixtureRoot, undefined, false, ['security'])` sonucu critical/high kümesi `expected.json` ile birebir; ayrıca konsola `yanlış alarm: N, kaçırma: M` yazdır.
- [ ] **Step 2:** `npx vitest run tests/precision.test.ts` → PASS (A1-A3 sonrası).
- [ ] **Step 3:** Commit `test: doğruluk ölçüm seti`.

### Task A8: PR 1 kapanışı

- [ ] `npm run typecheck && npm test` → PASS (yardımcı).
- [ ] D54 deposunda gerçek karşılaştırma: `node dist/cli.js scan --path /home/mcp/dogadayiz54-kaynak --no-llm --no-browser --json` → critical/high sayısı ve sağlık puanı, öncesi (1/146, 0) ile birlikte PR açıklamasına.
- [ ] README'de "Bastırma dosyası" bölümü (TR) + kısa EN özet.
- [ ] Push + PR, açıklama TR + EN.

## PR 2 — Kapsam (dal `feat/kapsam`, PR 1 merge sonrası main'den)

### Task B1: npm workspaces denetim girdisi

**Files:**
- Modify: `src/scanners/audit-input.ts:19-45` (`npmInput`)
- Test: `tests/static.test.ts` (`describe('araç girdileri')`)

**Kök neden (doğrulandı):** `npmInput` `node_modules/` ile başlamayan her yolda (`apps/web`, `apps/web/node_modules/x`) ve her `link: true` girdide `throw` ediyor; çalışma alanlı kilit dosyası bu yüzden hiç denetlenmiyor.

**Interfaces:**
- `npmInput(source)` imzası aynı. Davranış: `link: true` girdiler atlanır; `node_modules/` içermeyen yol (çalışma alanı kökü) atlanır; `<ws>/node_modules/<ad>` girdileri sentetik kilitte üst düzey `node_modules/<ad>`'a çakışmıyorsa oraya, çakışıyorsa `node_modules/d54-ws-<n>/node_modules/<ad>` altına konur (sentetik ebeveyn `{version:'0.0.0'}`). `resolved` npm registry dışıysa yalnız o girdi atlanır ve sayısı döner; tümü değil.
- Dönüş: `{ files: Record<string,string>; skipped: number }` — `prepareAudit` coverage'a `"N özel/yerel paket denetim dışı kaldı"` yazar. (İmza değişiyor: tek çağıranı `prepareAudit`, aynı dosyada.)

- [ ] **Step 1: Failing testler:** `workspace lock produces audit input` (kök + `apps/web/node_modules/zod` + `link:true` girdili kurgusal kilit → çıktıda `zod` sürümüyle var), `private resolved skipped not fatal`.
- [ ] **Step 2-4:** FAIL → uygula → PASS.
- [ ] **Step 5:** Commit `fix(audit): npm çalışma alanlı kilit dosyalarını denetle`.

### Task B2: Kapsam notlarını eyleme dönüştür

**Files:**
- Modify: `src/scanners/tooling.ts:138-148` (pip-audit yok notu), `src/engine.ts` (güven notu), `src/source.ts:35-47` (büyük dosya adları)
- Test: `tests/static.test.ts`, `tests/engine.test.ts`

**Benim kararım (spec B3'ten sapma):** MCP'ye `allow_project_commands` parametresi EKLENMEZ. Güven bilerek ortam değişkeniyle (`D54_MCP_TRUSTED_ROOT`) veriliyor; ajanın parametreyle açabilmesi bu korumayı deler. Yerine not netleşir.

- pip-audit yok → `"pip-audit bulunamadı. Kurulum: pipx install pip-audit"`.
- güvenilmeyen kök → `"Tip/lint/derleme atlandı. CLI: --trusted, MCP: D54_MCP_TRUSTED_ROOT=<proje yolu>."`
- büyük dosyalar → ilk 10 yol: `"Boyut sınırı nedeniyle içeriği okunmayan: a, b, … (+N)"`.

- [ ] **Step 1-4:** Her not için bir test (metin içerir) → FAIL → uygula → PASS.
- [ ] **Step 5:** Commit `feat: kapsam notlarına yapılacak adımı ekle`.

### Task B3: PR 2 kapanışı
- [ ] `npm run typecheck && npm test` PASS; D54 deposunda tarama → kök, web, mobil denetim satırları "tamamlandı" olmalı; PR TR + EN.

## PR 3 — LLM triyajı (dal `feat/triyaj`, PR 2 sonrası)

### Task C1: Triyaj modülü

**Files:**
- Create: `src/llm/triage.ts`
- Modify: `src/types.ts` (`Finding.triage?: { verdict: 'gerçek' | 'yanlış alarm' | 'belirsiz'; reason: string }`), `src/reporters/read.ts` (şema)
- Test: `tests/provider.test.ts` (sahte `LLMProvider`)

**Interfaces:**
- Consumes: `LLMProvider.complete(system, input)` (`src/llm/provider.ts:8`), `maskSecrets` (A1).
- Produces: `export async function triage(provider: LLMProvider, findings: Finding[], files: readonly SourceFile[], limit = 30): Promise<{ findings: Finding[]; notes: string[] }>`.
- Yalnız `critical|high`, en çok `limit` adet; bağlam = bulgu satırı ±15, her satır `maskSecrets`'ten geçer, bağlam en çok 4000 karakter. Model cevabı JSON `{"verdict": "...", "reason": "..."}`; ayrıştırılamazsa `belirsiz` + "model cevabı okunamadı". Hata/zaman aşımı bulguyu değiştirmez. notes: `"Triyaj: N bulgu modele gönderildi (sınır 30). Model: <ad>"`.

- [ ] **Step 1: Failing testler:** `attaches verdict from model`, `masks secret before sending` (sahte provider gelen girdide anahtar değeri GÖRMEMELİ), `unparseable reply is belirsiz`, `respects limit`, `never removes findings`.
- [ ] **Step 2-4:** FAIL → uygula → PASS.
- [ ] **Step 5:** Commit `feat(llm): kritik/yüksek bulgular için isteğe bağlı triyaj`.

### Task C2: CLI, MCP ve rapor bağlantısı

**Files:**
- Modify: `src/cli.ts` (`--triage`, `--llm` olmadan hata: "--triage için --llm gerekir"), `src/engine.ts` (`ScanOptions.triage?: boolean`, makeReport sonrası), `src/mcp-server.ts` (`triage: z.boolean().default(false)`; `use_llm` false iken true → hata), `src/reporters/markdown.ts` ("Model yanlış alarm dedi" ayrı bölüm)
- Test: `tests/engine.test.ts`, `tests/mcp.test.ts`, `tests/reporters.test.ts`

- [ ] **Step 1:** Testler: `triage requires llm` (CLI ve MCP), `markdown separates false positives`.
- [ ] **Step 2-4:** FAIL → uygula → PASS. **Step 5:** Commit `feat: --triage seçeneği`.

### Task C3: PR 3 kapanışı
- [ ] `npm run typecheck && npm test` PASS; README "Triyaj" bölümü (TR + EN özet); PR TR + EN; `gh repo edit mucipoz/d54-report --description "<TR> / <EN>"`.
