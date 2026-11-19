# D54 Report

<!-- markdownlint-configure-file
{"MD013":{"tables":false,"code_blocks":false}}
-->

## Özet

D54 Report bir proje dizinini, GitHub deposunu veya çalışan web sayfasını
inceler. Her bulgu için konum, kanıt, etki ve çözüm önerisi içeren Türkçe
Markdown ve JSON raporları üretir. Düzeltme komutu seçtiğiniz bulgular için
incelenebilir yamalar hazırlar. Temel tarama için hesap veya API anahtarı
gerekmez.

## İçindekiler

[Hızlı başlangıç](#hızlı-başlangıç) ·
[English quick start](#english-quick-start) · [Kapsam](#tarama-kapsamı) ·
[Model bağlantısı](#model-bağlantısı) · [Düzeltme](#düzeltme) ·
[GitHub Actions](#github-actions) · [MCP sunucusu](#mcp-sunucusu) ·
[Ajanlar](AGENT.md)

## Hızlı başlangıç

Node.js 20 veya üstü, npm ve Git kurulu olmalıdır. Klonladığınız D54 Report
dizininde çalıştırın.

```bash
npm ci
npm run build
npx --no-install playwright install chromium
npm link
d54-report scan --path ./demo-app --no-llm --out ./reports/demo
```

Linux'ta Chromium sistem kütüphaneleri eksikse
`npx --no-install playwright install --with-deps chromium` kullanın. Global
komut kurmadan depoda `node dist/cli.js` ile aynı seçenekleri kullanabilirsiniz.
Yerel demo, otomatik önizleme için kökte bir `index.html` içerir.
[Demo kaynakları](demo-app/) · [Örnek rapor ve çıktılar](examples/demo/)

## English quick start

From a clean checkout, use Node.js 20 or newer. Run `npm ci` and
`npm run build`. To enable visual review, run
`npx --no-install playwright install chromium`. Use `npm link` if you want the
`d54-report` executable on your PATH. The following command inspects the bundled
example, prints a JSON report and saves both Markdown and JSON to disk.

```bash
node dist/cli.js scan --path ./demo-app --no-llm --no-browser --json --out ./reports/source
```

To preview fixes for the low-severity findings in the latest report for this
demo, run the following command. It checks candidates in a temporary copy and
writes the preview to stderr. The JSON result identifies checks that require
trusted mode.

```bash
node dist/cli.js fix --path ./demo-app --out ./reports/source \
  --severity low --dry-run --no-llm --json
```

Use `--path` for local source, `--repo` for a public HTTPS GitHub repository,
and `--url` for an already running page. A URL can accompany either source
option. Only add `--trusted` to a reviewed local project when you authorize its
build and validation commands. Read `coverage` before interpreting the health
score. [Agent command contract](AGENT.md)

### Coverage and fix modes

Source rules cover syntax and imports, security review signals, dependencies,
performance, logic errors, Three.js, Rust and Tauri. Browser review samples the
initial desktop, tablet and mobile layouts. It allows same-origin GET/HEAD
requests. A root `index.html` can be previewed locally. Trusted mode also
supports recognized Vite, Next, Astro and Node development server scripts.
Security findings use source evidence, dependency advisories and observed page
headers. A finding may need manual confirmation.

Dependency advisories support npm (`package-lock.json` / `npm-shrinkwrap.json`),
Cargo, Composer and pinned `requirements.txt` (`pnpm-lock.yaml` and `yarn.lock`
are not supported). npm workspace lockfiles are audited from the root lockfile,
so a member without its own lockfile receives a `"kök kilidiyle denetlendi"`
note in `coverage`. npm package aliases are audited under their real package
name, while entries with a non-npm source, invalid name/version or a skipped
parent package are individually omitted and counted in `coverage`. When
`pip-audit` is missing, `coverage` suggests `pipx install pip-audit`. On
untrusted projects, type, lint and build checks are skipped; pass `--trusted` on
the CLI, or have the operator set `D54_MCP_TRUSTED_ROOT` for MCP (reviewed
local projects only).

`summary.counts` records each severity and `summary.health` scores completed
checks. Use `findings[].id` to select issues. The default `fix --mode patch`
saves a diff. Interactive mode prompts before changing a file. PR mode requires
approval to create a branch, push it and open a draft pull request. Use the
status in `results[]` to distinguish verification, application and publication.
[Fix statuses and exit codes](AGENT.md#request-a-fix)

### Provider configuration

The default scan runs without a model account or key. Optional model review
sends filtered structural lines and file paths from up to six source files.
Set `D54_PROVIDER`, `D54_MODEL` and `D54_API_KEY` in the operator environment.
When using an environment credential, set the endpoint or provider in the same
environment. Use `--config` to authorize a reviewed file with a custom endpoint.
For `openai-compatible`, set `D54_BASE_URL` to the Chat Completions API base.
A local server may accept requests without a key. `openai`, `deepseek` and
`glm` use Chat Completions. `anthropic` uses Messages with the
`anthropic-version: 2023-06-01` header. An operator-controlled JSON file can
supply `llm.provider`, `llm.model` and `llm.base_url` through `--config`.
[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create) ·
[Z.AI Chat Completion](https://docs.z.ai/api-reference/llm/chat-completion)

`--no-llm` disables model calls. Default advisory tools may contact public
services using package names and versions from isolated, sanitized inputs. For
offline source review, use an installed CLI, a local target, `--no-browser` and
`--no-llm` in an environment with external networking disabled. Check
`coverage` for unavailable advisory results.

### GitHub Actions setup in English

Copy `templates/github-action-d54-report.yml` into the target repository under
`.github/workflows/d54-report.yml`. Set the repository variables
`D54_REPORT_REPOSITORY` to the scanner's `owner/repo` and `D54_REPORT_REF` to
its reviewed, full 40-character commit SHA. Runs upload a `d54-report`
artifact. The critical threshold is enabled by default. Set the variable
`D54_FAIL_ON_CRITICAL=false` to disable it on push/PR, or use the manual
`fail-on-critical` input. For optional model review on push/manual runs, set
the secret `D54_API_KEY` and variables `D54_PROVIDER`, `D54_MODEL` and,
when applicable, `D54_BASE_URL`. PR scans always run with `--no-llm`. To
publish a numeric summary on fork PRs, add the optional companion workflow to
the default branch. [Scan workflow](templates/github-action-d54-report.yml) ·
[Fork summary workflow](templates/github-action-d54-fork-comment.yml)

### Key scan features

- **False-positive reduction:** Public prefixes (`NEXT_PUBLIC_`, `VITE_`, etc.), paths, spaced strings, and dot-notation paths are skipped; recognized key formats (AWS, GitHub, Slack) stay `high`; tracked service account JSONs trigger `critical` while gitignored copies drop to `low`.
- **Capped health score:** Penalties are calculated with strict caps per severity (Critical 40, High 30, Medium 20, Low 10) on a 100-point scale (`puan = 100 - penalty`).
- **Suppression file (`.d54report-ignore`):** Findings can be excluded via `<rule|*> <path-glob>[:line] # <reason>` in the target root. Reasons are mandatory; suppressed counts and suppressed real credentials are explicitly tracked.
- **Compact MCP summary:** `d54_scan_project` caps critical/high findings at 25 items and truncates evidence/impact/advice to 200 characters to conserve agent context.

### Triage

Optional model triage can be enabled with `scan --triage` on the CLI (with a configured model) or `use_llm: true, triage: true` in MCP `d54_scan_project`. Only the first 30 `critical` and `high` findings with source context (excluding secret-value findings) are sent, using a ±15 line window where detected sensitive lines are masked as `<gizli satır>`; catching every secret is not guaranteed — do not use triage on repositories containing real secrets. Model verdicts are informational only: no findings are removed and the health score does not change. Enabling triage sends scanned code snippets to the configured model provider and incurs API cost.

## Tarama kapsamı

| Hedef           | Komut veya örnek                                                       | Kanıt                                                             |
| --------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Yerel kaynak    | `d54-report scan --path ./demo-app --no-browser --no-llm`              | Dosya, satır ve statik kural                                      |
| GitHub deposu   | `d54-report scan --repo "$GITHUB_REPO_URL" --no-llm`                   | HTTPS ile geçici, sığ checkout. Değişkene tam depo URL'sini verin |
| Çalışan sayfa   | `d54-report scan --url http://127.0.0.1:4173 --no-llm`                 | URL, viewport, CSS seçicisi ve varsa ekran görüntüsü              |
| Kaynak ve sayfa | `d54-report scan --path demo-app --url http://127.0.0.1:4173 --no-llm` | Aynı raporda kaynak ve tarayıcı bulguları                         |

URL örnekleri için ayrı bir terminalde `npm --prefix demo-app start` çalıştırın.
Özel GitHub depoları için yerel checkout yolunu verin. Kaynak kökünde
`index.html` bulunuyorsa CLI geçici bir statik sunucu açar. Uygulamanız
geliştirme sunucusu veya giriş oturumu gerektiriyorsa seçtiğiniz URL'nin anonim
ilk görünümü ölçülür.

Yerel projede `--trusted` verilirse CLI önce desteklenen bir npm `dev` veya
`start` betiği arar. Tanınan Vite, Next, Astro ve basit Node sunucularını geçici
bir loopback portunda başlatır. Tarama sonrasında süreci kapatır. Diğer
uygulamalarda kökteki statik `index.html` veya sizin verdiğiniz `--url`
kullanılır.

| Bölüm            | Denetlenen örnekler                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Kod sağlığı      | JS/TS ve Python sözdizimi, JSON/YAML/TOML, göreli içe aktarımlar, ortam şablonları, boş catch                               |
| Güvenlik         | Kaynakta gizli değer örüntüleri, riskli SQL ve HTML oluşturma, yetkilendirme işaretleri, bağımlılık duyuruları              |
| Stabilite ve hız | Döngüde G/Ç, seri bekleme, yinelenen sorgular, büyük varlıklar, kapanış ve zaman aşımı yolları                              |
| UI/UX            | Masaüstü 1440×900, tablet 768×1024 ve mobil 390×844 boyutlarında taşma, okunabilirlik, çakışma ve erişilebilirlik örnekleri |
| Mantık           | Async forEach, sıfır bölen, NaN karşılaştırması, boş koleksiyon ve sınır koşulları                                          |
| Uzmanlık         | Three.js kaynak temizliği, RAF, bağlam kaybı, Rust panic/unsafe ve Tauri izinleri                                           |

Güvenlik incelemesi statik kaynak sinyallerine, yayımlanmış bağımlılık
duyurularına ve normal sayfa yüklemesinde görülen başlıklara dayanır. Bir
kaynağın veri akışını ve erişim yetkisini uygulama bağlamında doğrulayın.
Playwright her boyutta bir sayfa açar ve yalnız aynı kökenden GET/HEAD
isteklerini geçirir. Dış fontlar, CDN varlıkları ve kimlik doğrulaması
gerektiren içerik bu nedenle eksik görünebilir. İlk görünümde en çok 3.000 DOM
öğesi ve 180 kutu örneklenir. Ölçümler tek bir laboratuvar oturumuna aittir.

Chromium sandbox varsayılan olarak açıktır. Kurulu Chromium için
`D54_CHROMIUM_PATH` değişkenini kullanabilirsiniz. Sandbox desteği bulunmayan
yalıtılmış bir test ortamında, yalnız kendi güvendiğiniz demo için tek komutluk
istisna tanımlayabilirsiniz.

```bash
D54_CHROMIUM_SANDBOX=0 d54-report scan --path ./demo-app --no-llm
```

### Bağımlılıklar, ağ ve kapsam notları

Varsayılan bağımlılık denetimi geçici dizin ve ayrı bir ev dizini kullanır. npm
(`package-lock.json` / `npm-shrinkwrap.json`), Cargo ve Composer için
desteklenen kilit dosyasından, pip için tam sürüme sabitlenmiş
`requirements.txt` dosyasından temizlenmiş denetim girdisi üretir (`pnpm-lock.yaml`
ve `yarn.lock` desteklenmez). npm workspace kilitleri kök kilitten denetlenir;
kendi kilidi olmayan üye `coverage` içinde `"kök kilidiyle denetlendi"` notu
alır. npm takma adları gerçek paket adıyla denetlenir; npm dışı kaynak, geçersiz
ad/sürüm veya atlanan üst pakete bağlı girdiler ise tek tek dışarıda bırakılır
ve kapsam notunda sayılır. Paket adları ve sürümleri genel danışmanlık
hizmetlerine gönderilebilir. Araçlar sırasıyla `npm`, `cargo-audit`, `composer`
ve `pip-audit` olarak PATH üzerinden bulunur; `pip-audit` yoksa kurulum için
`pipx install pip-audit` ipucu verilir. Eksik araç, güvenle okunamayan girdi, ağ
hatası veya zaman aşımı raporun `coverage` alanında görünür.

`--no-llm` model yapılandırmasını ve model çağrılarını kapatır. Uzak depo, canlı
URL ve danışmanlık hizmetleri ayrı ağ işlemleridir. Çevrimdışı çalışırken kurulu
CLI'ı kullanın, yerel bir `--path` seçin ve tarayıcı gerekmiyorsa `--no-browser`
verin. Dış ağın kapalı olduğu ortamda danışmanlık sonuçları kısmi kalabilir.

Güvenilmeyen projede tip, lint ve derleme denetimleri atlanır; CLI'da
`--trusted`, MCP için ise operatör `D54_MCP_TRUSTED_ROOT` ayarlar (yalnız
incelenmiş yerel projede). `--trusted` TypeScript, mypy, PHP lint, PHPStan,
cargo check/clippy/build ve tanımlı npm build gibi proje komutlarını
etkinleştirir. Bu komutlar proje kodunu ve yapılandırmasını kullanabilir. Kaynak
toplamada sembolik bağlantılar ve derleme dizinleri atlanır. Dosya içeriği
başına 1 MiB ve toplamda 48 MiB okuma bütçesi vardır. Büyük dosyalar veya kilit
dosyaları genel kaynak taramasına yalnız boyut bilgisiyle girebilir.

### Yanlış alarm azaltma

Tarama motoru, gereksiz uyarıları önlemek ve gürültüyü azaltmak için bağlamsal filtreler uygular:

- **Genel anahtarlar ve istemci değerleri:** `NEXT_PUBLIC_`, `EXPO_PUBLIC_`, `VITE_` veya `PUBLIC_` önekli değişkenler ile adında "public" geçen değerler atlanır. `pk.` ile başlayan veya `.apps.googleusercontent.com` ile biten istemci anahtarları yoksayılır.
- **Yol ve metin filtreleri:** yalnız küçük harfli rota biçimindeki `/` ile başlayan değerler (ör. `/reset-password`; büyük harf içeren `/Xk2…` gibi değerler raporlanır), boşluk içeren dizgiler ve en çok 60 karakterlik harf-nokta yolları (ör. `users.verifyEmailToken`) kimlik bilgisi kabul edilmez.
- **Test ve CI ortamları:** Test/fixture dosyaları ve GitHub Actions iş akışlarındaki (`.github/workflows/`) `services:` bloklarında bulunan kimlik bilgileri `low` seviyesine indirilir.
- **Tanınan anahtarlar:** AWS, GitHub, Slack anahtarları veya özel anahtar (`PRIVATE KEY`) blokları gibi bilinen biçimler her zaman `high` önem derecesindedir.
- **Servis hesabı JSON dosyaları:** Git tarafından izleniyorsa `critical`, `.gitignore` ile dışlanmışsa `low` olarak işaretlenir.
- **SQL sorguları:** Şablon içindeki tüm `${}` ifadeleri güvenli/izinli sabitlerden oluşuyor ve değerler sorguya parametre dizisiyle aktarılıyorsa `low`, aksi durumda `high` atanır.

> **Bilinen ödünleşimler:** Boşluk içeren parolalar ve adında "public" geçen gizli değerler bu kurallar nedeniyle atlanır.

### Sağlık puanı

Sağlık puanı 100 üzerinden hesaplanır. Her önem derecesinin puan cezası tavan değerle sınırlandırılır:

$$\text{penalty} = \sum \min(\text{tavan}, \text{sayı} \times \text{ağırlık})$$
$$\text{puan} = 100 - \text{penalty}$$

| Önem Seviyesi | Ağırlık (Ceza / Adet) | Tavan Ceza |
| ------------- | :-------------------: | :--------: |
| `critical`    | 15                    | 40         |
| `high`        | 7                     | 30         |
| `medium`      | 3                     | 20         |
| `low`         | 1                     | 10         |

### Bulgu bastırma (.d54report-ignore)

Hedef proje kökündeki `.d54report-ignore` dosyasıyla bilinen veya beklenen bulgular bastırılabilir:

- **Satır biçimi:** `<kural|*> <yol-glob>[:<satır>] # <gerekçe>`
- **Zorunlu gerekçe:** Her kuraldan sonra `#` ile gerekçe belirtilmelidir; gerekçesiz satırlar yoksayılır ve rapor kapsam notlarında listelenir.
- **Glob kuralları:** `*` tek bir yol segmenti içinde eşleşir. `**` tek başına bir segment olarak sıfır veya daha çok klasörle eşleşir (segment içinde geçen `**` tek `*` sayılır). Kural deseni en fazla 256 karakter olabilir.
- **Dosya sınırları:** Dosya boyutu en çok 256 KiB olabilir; sembolik bağlar (symlink) okunmaz.
- **Puan ve rapor etkisi:** Bastırılan bulgular sağlık puanı cezasını etkilemez. Raporda "Bastırılan · N" ve ayrıca "Bastırılan gerçek biçimli anahtar · N" sayaçlarında gösterilir.

> **Uyarı:** Güvenilmeyen bir depoyu tararken o depo kendi bulgularını bu dosyayla gizleyebilir; raporlanan bastırılan bulgu sayısını mutlaka inceleyin.

Kural kimliği JSON raporundaki `rule` alanındadır.

**Örnek satırlar:**
```text
security.literal-secret tests/fixtures/** # Test senaryolarında kullanılan sahte anahtarlar
security.sql-construction src/legacy/query.ts:45 # Tablo adı allowlist doğrulamalı sabit metindir
* docs/examples/* # Belgelerdeki sözde kod örnekleri
```

### MCP özeti

Model Context Protocol (MCP) üzerinden çağrılan `d54_scan_project` aracı kompakt bir özet döndürür:

- `critical_high`: Önem derecesine göre sıralı en çok 25 öğe (`önem` → `kural` → `dosya` → `satır`).
- `critical_high_total`: Kritik ve yüksek öncelikli toplam bulgu sayısı.
- `rule_counts`: Kural bazında `critical`, `high` ve `medium` bulgu sayıları.
- **Alan kırpma:** Bağlam tasarrufu sağlamak için `evidence`, `impact` ve `advice` alanları en fazla 200 karakterde kesilir; eksiksiz bulgu listesi rapor dosyalarında tutulur.
- **Git deposu uyarısı:** Hedef bir Git deposuysa ve `reports/` dizini `.gitignore` içinde dışlanmamışsa kapsam notunda uyarı verilir.

## Model bağlantısı

Sağlayıcı ayarlanmadığında deterministik kurallar kullanılabilir. Model
incelemesi için sağlayıcınızdaki model kimliğini kullanın. API hesabı, model
erişimi ve ücretlendirme model hizmetine aittir. Bir editör aboneliğinin API
erişimi sağlayıp sağlamadığını o hizmetin hesabında kontrol edin.

| `D54_PROVIDER`              | Protokol                                          | Ayar                                                    |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| `anthropic`                 | Anthropic Messages, `POST /messages`              | Model ve anahtar                                        |
| `openai`, `deepseek`, `glm` | OpenAI Chat Completions, `POST /chat/completions` | Model ve anahtar, sağlayıcıya göre varsayılan taban URL |
| `openai-compatible`         | OpenAI Chat Completions uyumlu uç nokta           | Model, taban URL ve hizmet istiyorsa anahtar            |
| `none`                      | Model çağrıları kapalı                            | Yerel kurallar                                          |

`d54-report.config.json` çalışma dizininde aranır. `--config` ile operatöre ait
bir dosya seçebilirsiniz. Sağlayıcı alanları `llm` nesnesinde veya JSON kökünde
olabilir. Aynı dizindeki `.env` okunur. Öncelik süreç ortamı, `.env` ve JSON
ayarları sırasındadır. Anahtarı kabuk ortamında veya sürüm kontrolü dışında
tuttuğunuz `.env` dosyasında `D54_API_KEY` olarak verin. Anahtar ile sağlayıcıyı
veya uç noktayı aynı ortamda tanımlayın. Özel uç noktayı incelenmiş bir
JSON dosyasından kullanmak için o dosyayı `--config` ile seçin.
[Ortam şablonu](.env.example)

Aşağıdaki örnekte `model` alanını yerel sunucuda yüklü modelin kimliğiyle
değiştirin. Taban URL'ye protokol yolunu CLI ekler. Uzak sunucularda HTTPS,
loopback adreslerinde HTTP de kullanılabilir.

```json
{
  "llm": {
    "provider": "openai-compatible",
    "base_url": "http://127.0.0.1:11434/v1",
    "model": "YOUR_LOCAL_MODEL"
  }
}
```

```bash
d54-report scan --path ./demo-app --config ./d54-report.config.json
```

Model incelemesi en çok altı dosyadan seçilmiş yapısal satırları ve dosya
yollarını sağlayıcıya iletir. Her dosyada en çok 48 satır seçilir. Metin
sabitleri ve hassas içerik örüntüleri filtrelenir. Yetkilendirme, lisans
kontrolü, hız sınırı, yarış koşulu ve iş kuralı önerileri insan incelemesi
gerektirir. Model destekli JS/TS düzeltmesinde ilgili satır çevresindeki
maskelenmiş pencere gönderilir.

### Triyaj

İsteğe bağlı model triyajı CLI'da `scan --triage` (yapılandırılmış model ile), MCP `d54_scan_project` aracında `use_llm: true, triage: true` ile açılır. Yalnız ilk 30 `critical` ve `high` bulgu (gizli değer bulguları hariç), ±15 satırlık kaynak bağlamıyla değerlendirilir; tespit edilen hassas satırlar `<gizli satır>` olarak maskelenir; tüm sırları yakalama garantisi yoktur — gizli içerikli depolarda triyajı kullanmayın. Model kararı yalnızca bilgi amaçlıdır: hiçbir bulgu silinmez ve sağlık puanı değişmez. Triyaj açıldığında taranan kod parçaları yapılandırılmış modele veri olarak gönderilir ve kullanım maliyeti oluşturur.

## Düzeltme

Önce yerel projeyi tarayın. Aşağıdaki örnek son rapordaki bağlantı kuralının
kimliğini okuyup yalnız o bulgunun yamasını gösterir. Komutlar Bash ve temiz
checkout içindir.

```bash
mkdir -p reports/demo
d54-report scan --path demo-app --out reports/demo --no-browser --no-llm --json > reports/demo/selected.json
finding_id=$(node -p "require('./reports/demo/selected.json').findings.find(f => f.rule === 'security.target-blank').id")
d54-report fix --path demo-app --report reports/demo/selected.json --out reports/demo --ids "$finding_id" --dry-run --trusted --no-llm
```

| Seçim                 | Davranış                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--mode patch`        | Varsayılan mod. Birleşik diff dosyalarını çıktı dizinindeki `patches/` altında saklar                                                   |
| `--mode interactive`  | Terminalde farkı gösterir. `e` uygular, `h` atlar, `d` ayrıntı verir, `q` çıkar                                                         |
| `--mode pr`           | Onaylanan doğrulanmış yamaları ayrı Git worktree içinde denetler. Dal ve commit oluşturup origin'e göndermeyi ve taslak PR açmayı dener |
| `--dry-run`           | Uygulanabilir farkları stderr'de gösterir. Model düzeltmesi kapalıdır                                                                   |
| `--ids`, `--severity` | Virgülle ayrılmış rapor kimlikleri veya `critical,high,medium,low` düzeyleri ile süzer                                                  |
| `--force`             | Var olan çalışma alanı değişikliklerine rağmen ilerlemeye izin verir                                                                    |
| `--yes`               | PR modunda dal, commit, push ve taslak PR için etkileşimsiz onay verir                                                                  |

`--report` verilmezse çıktı dizininde aynı yerel köke ait en son D54 JSON raporu
seçilir. Her aday geçici kopyada uygulanıp yeniden taranır. Bildirilen kanıtın
giderilmesi ve yeni bulgu oluşmaması aranır. Projede tanımlı kontrolleri
çalıştırmak için `--trusted` gerekir. HTML bağlantı düzeltmesi deterministiktir.
Uygun hedeflerde yerel araç veya yapılandırılmış model aday yama üretebilir. Her
bulgunun otomatik düzeltmesi olmayabilir.

Modelin ürettiği fark önce Git denetiminden ve proje komutu çalıştırmayan bir
kaynak taramasından geçer. `patch` modu ve MCP bu farkı `PATCH_UNVERIFIED`
olarak dışa aktarır. Model yamasıyla proje kontrollerini çalıştırmak için
gerçek bir terminalde `--trusted` ile `interactive` veya `pr` modunu kullanın.
CLI dosyayı ve farkı gösterdikten sonra bu yamayı çalıştırmak için ayrı onay
ister. Uygulama veya PR yayımlama onayı doğrulama sonrasında geçerlidir.

Makine çıktısı için `--json` kullanın. Tarama JSON'u `schemaVersion`, `target`,
`stack`, `filesScanned`, `coverage`, `summary`, `findings` ve `priority` içerir.
Sağlık puanı tamamlanan denetimlerin ağırlıklı bulgularından hesaplanır.
Düzeltme çıktısında her sonuç için `id`, `status` ve varsa `detail` yer alır.
`patchPath` oluşturulan yamanın yoludur. `verification` her adım için
`passed`, `failed` veya `skipped` durumunu bildirir. Çıkış kodları ve durum
adları ajan sözleşmesinde listelenir.
[Ajan sözleşmesi](AGENT.md)

## GitHub Actions

Bu depodaki iş akışları D54 Report'un kendisini tarar. Başka bir projede
şablonları varsayılan daldaki `.github/workflows/` dizinine kopyalayın.
Aşağıdaki komutları D54 checkout'undan çalıştırırken `TARGET_REPO` değişkenine
hedef yerel depo yolunu verin.

```bash
mkdir -p "$TARGET_REPO/.github/workflows"
cp templates/github-action-d54-report.yml "$TARGET_REPO/.github/workflows/d54-report.yml"
cp templates/github-action-d54-fork-comment.yml "$TARGET_REPO/.github/workflows/d54-fork-comment.yml"
```

1. Hedef deponun **Settings → Secrets and variables → Actions → Variables**
   bölümüne `D54_REPORT_REPOSITORY` olarak tarayıcı deposunun `owner/repo` adını
   girin. `D54_REPORT_REF` için o depoda erişilebilen, incelediğiniz sürümün tam
   40 karakterlik commit SHA'sını girin. Erişilebilir bir tarayıcı deposu
   gerekir.
2. Push, pull request veya manuel çalıştırmada workflow sabitlenmiş tarayıcıyı
   kurar, hedefi varsayılan olarak `--no-llm` ile tarar ve `d54-report`
   artifact'ine raporları yükler. Push ve manuel çalıştırmada isteğe bağlı model
   için `D54_API_KEY` depo secret'ını, `D54_PROVIDER` ve `D54_MODEL` depo
   değişkenlerini tanımlayın. Özel taban URL gerekiyorsa `D54_BASE_URL`
   değişkenini ekleyin. PR taramaları her zaman `--no-llm` kullanır. Aynı
   depodan gelen PR'larda sayı ve sağlık özeti yorum olarak güncellenir.
3. İkinci şablon fork PR'larındaki özet yorumu için isteğe bağlıdır. Varsayılan
   daldaki ayrı `workflow_run` işi yalnız sayısal iş özetini ve eşleşen PR
   kimliğini kullanır. [CI şablonu](templates/github-action-d54-report.yml) ·
   [Fork yorum şablonu](templates/github-action-d54-fork-comment.yml)
4. Kritik bulgular varsayılan olarak CI eşiğini tetikler. Push/PR için kapatmak
   üzere `D54_FAIL_ON_CRITICAL=false` depo değişkenini tanımlayın. Manuel
   çalıştırmada `fail-on-critical` girdisini seçin. Yerel eşdeğeri
   `d54-report scan --path demo-app --no-llm --fail-on-critical` komutudur.

## MCP sunucusu

Node.js 20+ ile D54 checkout'unda aşağıdaki komutları çalıştırın.
`npm link`, CLI ile birlikte `d54-report-mcp` yürütülebilirini de npm'in
global komut dizinine bağlar. İstemci bu komutu bir alt süreç olarak başlatır
ve MCP mesajlarını stdin/stdout üzerinden taşır. Günlükler stderr'e gider.

```bash
npm ci
npm run build
npm link
```

### Claude Code ve JSON kullanan istemciler

Claude Code için aşağıdaki içeriği hedef projenin kökündeki `.mcp.json`
dosyasına ekleyin. Aynı `mcpServers` biçimini kabul eden diğer istemcilerin
MCP ayarlarında da bu nesne kullanılabilir. İstemcinin PATH'i global npm
komutlarını içermiyorsa `command` alanına yürütülebilirin mutlak yolunu verin.
[Claude Code MCP belgesi](https://code.claude.com/docs/en/mcp)

```json
{
  "mcpServers": {
    "d54-report": {
      "command": "d54-report-mcp",
      "args": []
    }
  }
}
```

### Codex

Codex CLI ile kaydedip yapılandırılmış sunucuyu listeleyebilirsiniz.
[Codex MCP belgesi](https://developers.openai.com/codex/mcp/)

```bash
codex mcp add d54-report -- d54-report-mcp
codex mcp list
```

Kullanıcı düzeyindeki `~/.codex/config.toml` içinde eşdeğer kayıt şöyledir.

```toml
[mcp_servers.d54-report]
command = "d54-report-mcp"
args = []
```

Codex App Server'a bağlı, başlatılmış bir istemci aynı ayarı aşağıdaki JSON
isteğiyle kullanıcı yapılandırmasına yazabilir. `upsert` belirtilen kayıt
alanlarını günceller. [Resmi parametre şeması](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ConfigValueWriteParams.ts)

```json
{
  "id": 1,
  "method": "config/value/write",
  "params": {
    "keyPath": "mcp_servers.d54-report",
    "value": { "command": "d54-report-mcp", "args": [] },
    "mergeStrategy": "upsert"
  }
}
```

### Araçlar ve örnek çağrılar

İlk istekte `path` olarak MCP sunucusunun makinesindeki proje dizinini seçin.
Sonraki isteklerde örnek rapor yollarını ilk yanıtın döndürdüğü gerçek yollarla
değiştirin. Tarama ve düzeltme sonuçları hem `structuredContent` hem de JSON
metni olarak gelir.

**`d54_scan_project`** yerel `path` ister. `url` isteğe bağlı çalışan sayfa,
`use_llm` varsayılan olarak `false`, `modules` ise isteğe bağlı kategori
listesidir. Liste verilmezse altı modül seçilir. Geçerli adlar `errors`,
`security`, `performance`, `ui`, `bugs` ve `specialized` değerleridir.
Yalnız seçili denetimler çalışır. Model incelemesi için `security` seçilmeli
ve `use_llm` açık olmalıdır.

```json
{
  "path": "/work/project",
  "modules": ["errors", "bugs"],
  "use_llm": false
}
```

Yanıtta `summary` toplamı, önem sayıları ve sağlık puanını verir.
`report_paths.markdown` ve `report_paths.json` seçilen projenin `reports/`
dizinindeki dosyalardır. `critical_high` kritik ve yüksek bulguları,
`modules` seçilen modülleri, `coverage` kapsam notlarını,
`browser_unavailable` istenen tarayıcı denetiminin durumunu bildirir.
`scan_incomplete` istenen taramanın eksik kaldığını gösterir. Nedeni `coverage` alanında yer alır.
Diğer önem düzeyleri tam raporda bulunur.

**`d54_fix_findings`** için `report_path` yerel proje kökünü içeren D54 JSON
raporudur. `mode` değeri `patch` (varsayılan) veya `pr` olabilir. `ids` ve
`severity` filtreleri liste veya virgülle ayrılmış metin kabul eder.
`dry_run` varsayılan olarak `false` değerindedir. Aşağıdaki örnekte
seçtiğiniz kimlik raporda bulunmalıdır.

```json
{
  "report_path": "/work/project/reports/selected.json",
  "mode": "patch",
  "ids": ["ERR-001"],
  "dry_run": true
}
```

`patch_paths` oluşturulan yama dosyalarını, `successful` doğrulanan
`PATCH_CREATED`, `PR_CREATED` veya `DRY_RUN` sonuçlarını, `rolled_back`
başarısız geri alınanları listeler. Tüm durumlar `results` içinde bulunur.
Her kayıt `id` ve `status` içerir. Gerektiğinde `detail`, `patchPath` ve
`verification` eklenir. Doğrulama adımlarında `stage`, `status`
(`passed`, `failed`, `skipped`) ve varsa `detail` okunabilir.

**`d54_get_report`** yalnız `report_path` alır ve Markdown belgesini eksiksiz
MCP metin içeriğinde döndürür. Markdown dosyasının kendisini veya aynı adlı
Markdown dosyası yanında bulunan D54 JSON raporunu seçin.

```json
{ "report_path": "/work/project/reports/selected.md" }
```

### Operatör ayarları

- `D54_MCP_TRUSTED_ROOT` tek bir yerel proje kökünü yetkilendirir. Sunucu
  sembolik bağlantıları çözdükten sonra tam yol eşitliği arar. Bu eşleşme
  proje komutlarının ve düzeltme doğrulamalarının çalışmasına izin verir.
- `D54_MCP_CONFIG`, sunucu operatörüne ait model yapılandırmasının yoludur.
  Dosya verilmediğinde model ayarları sunucu işlem ortamından alınır.
  `D54_MCP_FIX_LLM=1` gerçek düzeltme çağrılarında isteğe bağlı model
  kullanımını etkinleştirir. MCP model yamalarını inceleme için dosyaya kaydeder.
  Dry run model düzeltmesi çağırmaz.
- Bir taslak PR yayımlamak için istemci, etkileşimli MCP formunda açık kullanıcı
  onayı alır. Operatörün tek bir proje için yayına önceden izin vermesi de
  mümkündür. Bu durumda tam `D54_MCP_TRUSTED_ROOT` eşleşmesi ve
  `D54_MCP_ALLOW_PR=1` birlikte gerekir. Yayımlama dal, commit, push ve
  taslak PR işlemlerini kapsar.

### MCP in English

Build the checkout, run `npm link` and configure your stdio client to launch
`d54-report-mcp`. Use the Claude Code JSON or Codex TOML above. Pass a local
directory and optional modules to `d54_scan_project`. Read `coverage` and
use the returned `report_paths.json` for `d54_fix_findings` or
`report_paths.markdown` for `d54_get_report`. For a preview, supply
`dry_run: true`. Use the status of each result to distinguish saved patches
from completed verification. [Agent contract](AGENT.md)

## Lisans / License

**PolyForm Noncommercial 1.0.0.** [Lisans metni / License text](LICENSE)

- Ticari olmayan her amaçla ücretsiz kullanabilir, değiştirebilir, geliştirebilir ve paylaşabilirsiniz.
- Dağıtırken lisans metnini ve `Required Notice:` satırını korumanız gerekir. Kaynak: Mucip ÖZ - elithost.com.tr (sm@elithost.com.tr).
- Ticari kullanım ve satış izni yoktur.

- Free to use, modify, improve and share for any noncommercial purpose.
- When distributing, keep the license text and the `Required Notice:` line. Source: Mucip ÖZ - elithost.com.tr (sm@elithost.com.tr).
- Commercial use and selling are not permitted.

Bu depo daha önce MIT lisansıyla yayımlanıyordu; yeni lisans bu değişiklikten sonraki sürümler için geçerlidir. / This repository was previously released under MIT; the new license applies to versions after this change.
