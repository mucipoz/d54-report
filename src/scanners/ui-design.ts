import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import type { Issue } from '../types.js';
import { ensureOutputDirectory } from '../fs-guards.js';
import { passiveRequests } from './passive-request.js';

const sizes = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

type Box = { x: number; y: number; width: number; height: number };
type Sample = { rule: string; selector: string; evidence: string; box: Box };
type Description = Pick<Issue, 'title' | 'impact' | 'advice' | 'severity'>;

const rules: Record<string, Description> = {
  overlap: { title: 'İçerik bölgeleri üst üste biniyor', severity: 'medium', impact: 'Kesişen içerik okunamayabilir veya yanlış kontrol seçilebilir.', advice: 'İki seçicinin kutularını inceleyip boşluk ve hizalamayı düzeltin.' },
  overflow: { title: 'Öğe ekranın yatay sınırını aşıyor', severity: 'medium', impact: 'İçeriğin bir kısmı ekran dışında kalabilir.', advice: 'Sabit genişlik, minimum genişlik ve satır kaydırma kurallarını inceleyin.' },
  clipped: { title: 'Metin kutunun içine sığmıyor', severity: 'low', impact: 'Kullanıcı metnin tamamını göremeyebilir.', advice: 'Kutu yüksekliği, genişliği ve metnin satır kaydırma davranışını kontrol edin.' },
  obscured: { title: 'Kontrolün merkezi başka bir öğeyle örtülü', severity: 'medium', impact: 'Kontrolün merkezine yapılan tıklama başka bir öğeye ulaşır.', advice: 'Katman sırasını ve örtüşen öğenin konumunu inceleyin.' },
  image: { title: 'Görsel yüklenemedi', severity: 'medium', impact: 'Görsel içeriği eksik gösterilir.', advice: 'Görsel kaynağını ve ağ yanıtını doğrulayın.' },
  font: { title: 'Tanımlı yazı tipi yüklenemedi', severity: 'low', impact: 'Yazı ölçüleri ve satır sonları değişebilir.', advice: 'Yazı tipi kaynağını, biçimini ve sunucu yanıtını inceleyin.' },
  icon: { title: 'SVG simgesinin yerel hedefi bulunamadı', severity: 'medium', impact: 'Simge boş görüntülenebilir.', advice: 'use öğesinin başvurduğu SVG kimliğini doğrulayın.' },
  contrast: { title: 'Metin kontrastı düşük', severity: 'medium', impact: 'Metin ile zemin arasındaki fark okumayı zorlaştırabilir.', advice: 'Metin veya zemin rengini ölçülen eşik karşılanacak şekilde güncelleyin.' },
};

// Playwright serializes this function into the page. Keep browser helpers inside it.
function inspectViewport() {
  const samples: Sample[] = [];
  const counts = new Map<string, number>();
  const width = document.documentElement.clientWidth;
  const height = innerHeight;
  const interactive = 'a[href],button,input:not([type=hidden]),select,textarea,nav,[role=menuitem],[role=button],[role=link],[role=tab]';
  const selector = (element: Element) => {
    const parts: string[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      let position = 1;
      for (let prev = node.previousElementSibling; prev; prev = prev.previousElementSibling) {
        if (prev.localName === node.localName) position++;
      }
      parts.unshift(CSS.escape(node.localName) + ':nth-of-type(' + position + ')');
    }
    return parts.join(' > ');
  };
  function record(rule: string, el: Element, evidence: string, rect: DOMRect) {
    const count = counts.get(rule) ?? 0;
    counts.set(rule, count + 1);
    if (count >= 3) return;
    const x = Math.max(0, Math.floor(rect.left - 12));
    const y = Math.max(0, Math.floor(rect.top - 12));
    const right = Math.min(width, Math.ceil(rect.right + 12));
    const bottom = Math.min(height, Math.ceil(rect.bottom + 12));
    if (right <= x || bottom <= y) return;
    samples.push({ rule, selector: selector(el), evidence, box: { x: x + scrollX, y: y + scrollY, width: right - x, height: bottom - y } });
  }
  const rgb = (value: string) => {
    const match = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(value);
    if (!match) return null;
    const [r, g, b] = match.slice(1).map(v => {
      const n = Number(v) / 255;
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  function background(el: Element): number | null {
    let color: number | undefined;
    for (let node: Element | null = el; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.opacity !== '1' || s.mixBlendMode !== 'normal' || s.filter !== 'none') return null;
      if (color !== undefined) continue;
      if (s.backgroundImage !== 'none') return null;
      if (s.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        const lum = rgb(s.backgroundColor);
        if (lum === null) return null;
        color = lum;
      }
    }
    return color ?? 1;
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  const boxes: { el: Element; rect: DOMRect }[] = [];
  let seen = 0;
  for (let el = walker.nextNode() as Element | null; el && seen < 3000; el = walker.nextNode() as Element | null) {
    seen++;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || rect.bottom <= 0 || rect.top >= height || rect.right <= 0 || rect.left >= width) continue;
    const style = getComputedStyle(el);
    if (style.visibility !== 'visible' || !el.checkVisibility({ checkOpacity: true })) continue;
    const isControl = el.matches(interactive);
    const hasText = el.children.length === 0 && Boolean(el.textContent?.trim());
    if ((isControl || el.matches('h1,h2,h3,h4,p,img,label')) && (rect.left < -2 || rect.right > width + 2)) {
      let scroller = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) { scroller = true; break; }
      }
      if (!scroller) record('overflow', el, 'Yatay sınırlar ' + Math.round(rect.left) + '–' + Math.round(rect.right) + ' px, ekran ' + width + ' px.', rect);
    }
    if (hasText && style.textOverflow !== 'ellipsis' && style.webkitLineClamp === 'none' && (
      (/hidden|clip/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 2) ||
      (/hidden|clip/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 2))) {
      record('clipped', el, 'İçerik ' + el.scrollWidth + '×' + el.scrollHeight + ' px, görünür kutu ' + el.clientWidth + '×' + el.clientHeight + ' px.', rect);
    }
    if (el instanceof HTMLImageElement && el.complete && el.currentSrc && el.naturalWidth === 0) {
      record('image', el, 'Görsel yükleme işlemi tamamlandı, doğal genişlik 0 px.', rect);
    }
    if (el instanceof SVGSVGElement) {
      const ref = el.querySelector('use');
      const href = ref?.getAttribute('href') ?? ref?.getAttribute('xlink:href');
      if (href?.startsWith('#') && !document.getElementById(href.slice(1))) record('icon', el, 'Yerel use başvurusunun belge içinde hedefi yok.', rect);
    }
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const top = document.elementFromPoint(cx, cy);
    if (isControl && style.pointerEvents !== 'none' && !el.matches(':disabled') && top && !el.contains(top) && !top.contains(el)) {
      record('obscured', el, 'Merkezdeki öğe ' + selector(top) + '.', rect);
    }
    if (hasText && top && el.contains(top) && style.textShadow === 'none') {
      const fg = rgb(style.color);
      const bg = background(el);
      if (fg !== null && bg !== null) {
        const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.67 && parseInt(style.fontWeight) >= 700);
        const threshold = large ? 3 : 4.5;
        if (ratio < threshold) record('contrast', el, 'Hesaplanan oran ' + ratio.toFixed(2) + ':1, eşik ' + threshold + ':1.', rect);
      }
    }
    if (isControl || (hasText && el.matches('h1,h2,h3,h4,p,label'))) {
      if (boxes.length < 180) boxes.push({ el, rect });
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i]!;
    for (const b of boxes.slice(i + 1)) {
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const h = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      const smaller = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);
      if (w < 5 || h < 5 || w * h < smaller * 0.12) continue;
      const region = new DOMRect(Math.max(a.rect.left, b.rect.left) - 16, Math.max(a.rect.top, b.rect.top) - 16, w + 32, h + 32);
      record('overlap', a.el, selector(b.el) + ' ile ' + Math.round(w) + '×' + Math.round(h) + ' px kesişme.', region);
    }
  }
  for (const font of document.fonts) {
    if (font.status !== 'error') continue;
    const entry = boxes.find(b => getComputedStyle(b.el).fontFamily.split(',').map(v => v.trim().replace(/["']/g, '').toLowerCase()).includes(font.family.replace(/["']/g, '').toLowerCase()));
    if (entry) record('font', entry.el, 'Etkin font listesinde yükleme durumu error olan FontFace bulundu.', entry.rect);
  }
  return { samples, seen, counts: Object.fromEntries(counts) };
}

type Vitals = { lcp: number | null; cls: number | null };
function observeVitals() {
  const values: Vitals = { lcp: null, cls: null };
  Object.defineProperty(window, '__d54Vitals', { value: values, configurable: true });
  if (PerformanceObserver.supportedEntryTypes.includes('largest-contentful-paint')) {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) values.lcp = entry.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  }
  if (PerformanceObserver.supportedEntryTypes.includes('layout-shift')) {
    values.cls = 0;
    let start = -Infinity, previous = -Infinity, sum = 0;
    new PerformanceObserver(list => {
      for (const item of list.getEntries()) {
        const shift = item as PerformanceEntry & { hadRecentInput: boolean; value: number };
        if (shift.hadRecentInput) continue;
        if (shift.startTime - previous >= 1000 || shift.startTime - start >= 5000) {
          sum = 0;
          start = shift.startTime;
        }
        previous = shift.startTime;
        sum += shift.value;
        values.cls = Math.max(values.cls ?? 0, sum);
      }
    }).observe({ type: 'layout-shift', buffered: true });
  }
}

function countRuntime(page: Page) {
  const events = { exceptions: 0, consoleErrors: 0, failed: 0, httpErrors: 0 };
  page.on('pageerror', () => { events.exceptions++; });
  page.on('console', msg => { if (msg.type() === 'error') events.consoleErrors++; });
  page.on('requestfailed', request => {
    if (['GET', 'HEAD'].includes(request.method()) && request.failure()?.errorText !== 'net::ERR_BLOCKED_BY_CLIENT') events.failed++;
  });
  page.on('response', res => { if (res.status() >= 400) events.httpErrors++; });
  return events;
}

export async function scanUI(url: string, out: string, localFixture = true): Promise<{ issues: Issue[]; notes: string[]; completed: number }> {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Tarama adresi kimlik bilgisi içermeyen HTTP(S) olmalıdır.');
  const cleanUrl = target.origin + target.pathname;
  const key = randomUUID();
  const issues: Issue[] = [];
  let completed = 0;
  const notes: string[] = [];
  await ensureOutputDirectory(join(out, 'screenshots'));
  const launch = (sandbox: boolean) => chromium.launch({
    executablePath: process.env.D54_CHROMIUM_PATH || undefined, chromiumSandbox: sandbox, timeout: 15000,
    args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
  });
  const localOverride = localFixture && ['127.0.0.1','[::1]','localhost'].includes(target.hostname)
    && process.env.D54_CHROMIUM_SANDBOX === '0';
  const browser = await launch(!localOverride);
  try {
    for (const size of sizes) {
      const viewport = size.name + ' ' + size.width + '×' + size.height;
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, serviceWorkers: 'block', acceptDownloads: false });
      const scope = { url: cleanUrl, viewport };
      let blocked = 0;
      const passive = passiveRequests(target.origin);
      let documentRedirect: string | undefined;
      const page = await context.newPage();
      const timer = setTimeout(() => { void context.close().catch(() => {}); }, 40_000);
      try {
        await context.routeWebSocket('**/*', socket => { blocked++; socket.close(); });
        await context.route('**/*', route => {
          const req = route.request();
          let main = false;
          if (req.isNavigationRequest()) {
            try { main = req.frame() === page.mainFrame(); } catch { /* Çerçevesi henüz oluşmayan istek. */ }
          }
          return passive.routeRequest(route, main ? to => { documentRedirect = to; } : undefined);
        });
        await page.addInitScript(observeVitals);
        const runtime = countRuntime(page);
        let response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
        for (let hop = 0; documentRedirect && hop < 5; hop++) {
          const to = documentRedirect;
          documentRedirect = undefined;
          response = await page.goto(to, { waitUntil: 'domcontentloaded', timeout: 12000 });
        }
        if (documentRedirect || !response || !response.ok()) {
          notes.push(viewport + ' hedef belgesi ölçülemedi. HTTP durumu ' + (response?.status() ?? 'alınamadı') + '.');
          continue;
        }
        if (new URL(page.url()).origin !== target.origin) {
          notes.push(viewport + ' farklı kökene yönlendirildi, hedef sayfa ölçülemedi.');
          continue;
        }
        await page.waitForLoadState('load', { timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(650);
        const metrics = await page.evaluate(() => {
          const vitals = (window as unknown as { __d54Vitals: Vitals }).__d54Vitals;
          const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
          return { ...vitals, ttfb: nav?.responseStart || null, metaCsp: Boolean(document.querySelector('meta[http-equiv="content-security-policy" i]')) };
        });
        const headers = response?.headers();
        const documentHeaders = size.name === 'desktop' ? headers : undefined;
        if (documentHeaders && target.protocol === 'https:' && !/\bmax-age\s*=\s*[1-9]\d*/i.test(documentHeaders['strict-transport-security'] ?? '')) {
          issues.push({ url:cleanUrl, rule:'security.missing-hsts',category:'security',severity:'low',title:'HTTPS yanıtında etkin HSTS görülmedi',evidence:'Belge yanıtında pozitif max-age değeri bulunamadı.',impact:'Sonraki bağlantılarda tarayıcı HTTPS kullanımını zorunlu tutmayabilir.',advice:'HTTPS dağıtım kapsamını doğrulayıp uygun Strict-Transport-Security başlığı ekleyin.' });
        }
        if (documentHeaders && !/^(DENY|SAMEORIGIN)$/i.test(documentHeaders['x-frame-options'] ?? '') && !/(?:^|;)\s*frame-ancestors\s/i.test(documentHeaders['content-security-policy'] ?? '')) {
          issues.push({ url:cleanUrl,rule:'security.frame-policy',category:'security',severity:'low',title:'Belgede çerçeveleme politikası görülmedi',evidence:'X-Frame-Options veya CSP frame-ancestors bulunamadı.',impact:'Başka bir site belgeyi çerçeve içine yerleştirebilir.',advice:'Gömme gereksinimine göre frame-ancestors veya X-Frame-Options tanımlayın.' });
        }
        if (documentHeaders && !documentHeaders['content-security-policy'] && !metrics.metaCsp) {
          issues.push({ ...scope, rule: 'security.missing-csp', category: 'security', severity: 'low', title: 'Belgede içerik güvenliği politikası görülmedi', evidence: 'Ana belge yanıtında CSP başlığı veya belgede CSP meta öğesi bulunamadı.', impact: 'Tarayıcıda çalışabilecek kaynaklar için ek bir kısıtlama saptanmadı.', advice: 'Uygulamanın kaynakları için uygun bir CSP tanımlamayı değerlendirin.' });
        }
        if (documentHeaders && documentHeaders['x-content-type-options']?.toLowerCase() !== 'nosniff') {
          issues.push({ ...scope, rule: 'security.missing-nosniff', category: 'security', severity: 'low', title: 'Belge yanıtında nosniff eksik', evidence: 'X-Content-Type-Options başlığı nosniff değerini taşımıyor.', impact: 'Yanıtta MIME türü algılamasına ilişkin ek koruma görülmedi.', advice: 'Sunucu yapılandırmasındaki MIME türlerini ve nosniff başlığını gözden geçirin.' });
        }
        for (const [name, value, limit] of [['LCP', metrics.lcp, 2500], ['CLS', metrics.cls, 0.1], ['TTFB', metrics.ttfb, 800]] as const) {
          const unit = name === 'CLS' ? '' : ' ms';
          const measured = value == null ? 'ölçülemedi' : Number(value.toFixed(3)) + unit;
          notes.push(viewport + ' · ' + name + ' ' + measured);
          if (value != null && value > limit) issues.push({ ...scope, category: 'performance', rule: 'performance.browser-' + name.toLowerCase(), severity: 'medium', title: name + ' laboratuvar eşiğini aşıyor', evidence: measured + ', eşik ' + limit + unit + '.', impact: 'İlk yükleme sırasında gecikme veya düzen kayması gözlenebilir.', advice: 'Tekil ölçümü tekrarlı taramalar ve gerçek kullanıcı verileriyle karşılaştırın.' });
        }
        const inspected = await page.evaluate(inspectViewport);
        let index = 0;
        for (const sample of inspected.samples.slice(0, Object.keys(rules).length * 3)) {
          if (!sample || typeof sample.rule !== 'string' || !Object.hasOwn(rules,sample.rule) || typeof sample.selector !== 'string' ||
              typeof sample.evidence !== 'string' || sample.selector.length > 4096 || sample.evidence.length > 8192 ||
              !sample.box || !Object.values(sample.box).every(Number.isFinite) || sample.box.x < 0 || sample.box.y < 0 ||
              sample.box.width <= 0 || sample.box.width > size.width || sample.box.height <= 0 || sample.box.height > size.height) continue;
          const description = rules[sample.rule]!;
          const shot = 'screenshots/' + key + '-' + size.name + '-' + sample.rule + '-' + (++index) + '.png';
          let screenshot: string | undefined;
          try {
            const png = await page.screenshot({ type: 'png', clip: sample.box, timeout: 2000, mask: [page.locator('input,textarea,[contenteditable=true]')] });
            await ensureOutputDirectory(join(out,'screenshots'));
            await writeFile(join(out, shot), png, { flag:'wx', mode:0o600 });
            screenshot = shot;
          } catch {
            notes.push(viewport + ' · ' + sample.rule + ' ekran görüntüsü kaydedilemedi.');
          }
          issues.push({ ...scope, ...description, category: 'ui', rule: 'ui.' + sample.rule, selector: sample.selector, evidence: sample.evidence, ...(screenshot ? { screenshot } : {}) });
        }
        const names = { exceptions: 'Yakalanmayan tarayıcı hatası', consoleErrors: 'Konsol hatası', failed: 'Başarısız ağ isteği', httpErrors: 'HTTP hata yanıtı' };
        for (const event of Object.keys(names) as (keyof typeof names)[]) {
          if (runtime[event]) issues.push({ ...scope, category: 'errors', rule: 'errors.browser-' + event, severity: 'medium', title: names[event], evidence: runtime[event] + ' olay gözlendi. Ham günlük, istek parametreleri ve gövdeler rapora alınmadı.', impact: 'Sayfanın yüklenmesi veya istemci işlevleri etkilenebilir.', advice: 'İlgili sayfayı geliştirici araçlarında açıp konsolu ve Ağ panelini inceleyin.' });
        }
        const omitted = Object.values(inspected.counts).reduce((a, n) => a + Math.max(0, n - 3), 0);
        notes.push(viewport + ' · ' + inspected.seen + ' DOM öğesi incelendi, ' + omitted + ' ek örnek rapor sınırını aştı.');
        completed++;
      } catch (error) {
        const name = error instanceof Error && error.name === 'TimeoutError' ? 'zaman aşımı' : 'gezinti veya ölçüm hatası';
        notes.push(viewport + ' ölçümü tamamlanamadı (' + name + ').');
      } finally {
        clearTimeout(timer);
        blocked += passive.counters.blocked;
        if (blocked) notes.push(viewport + ' · ' + blocked + ' istek engellendi veya tamamlanamadı. Yalnız aynı kökenden GET/HEAD yüklendi. Dış kaynak veya ağ bütçesi gerektiren öğeler eksik görünebilir.');
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  notes.push('Her boyutta bir adres açıldı. İlk görünümde en çok 3000 DOM öğesi ve 180 etkileşim/metin kutusu örneklendi. Her kural için en çok üç bölge kaydedildi. Form, giriş, kaydırma, iframe içeriği ve Shadow DOM incelenmedi. Performans değerleri kısa bir laboratuvar gözlemidir.');
  return { issues, notes, completed };
}
