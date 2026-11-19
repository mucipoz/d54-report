import { basename, resolve } from 'node:path';
import { lstat, readFile, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { snapshot, technology } from './source.js';
import { checkout, preview } from './targets.js';
import { startProject } from './project-preview.js';
import { categories, type Category, type Issue, type Report, type SourceFile, type Target } from './types.js';
import { scan as errors } from './scanners/errors.js';
import { scan as security } from './scanners/security.js';
import { scan as performance } from './scanners/performance.js';
import { scan as bugs } from './scanners/bugs.js';
import { scan as specialized } from './scanners/specialized.js';
import { scanTools } from './scanners/tooling.js';
import { scanSignals } from './scanners/review-signals.js';
import { syntax } from './scanners/syntax.js';
import { scanUI } from './scanners/ui-design.js';
import { review } from './llm/review.js';
import type { LLMProvider } from './llm/provider.js';
import { json, makeReport } from './reporters/json.js';
import { markdown } from './reporters/markdown.js';

const sourceScanners = { errors, security, performance, bugs, specialized };
function selectedModules(input: readonly Category[] = categories): Category[] {
  if (!input.length || input.some(m => !categories.includes(m))) throw Error('En az bir geçerli tarama modülü seçin.');
  return [...new Set(input)];
}

export async function staticAudit(root:string, out?:string, trusted=false, modules?:readonly Category[]) {
  const selected = selectedModules(modules);
  const scanners = selected.flatMap(m => m === 'ui' ? [] : [sourceScanners[m]]);
  if (!scanners.length) return { files: [] as SourceFile[], issues: [] as Issue[], notes: [] as string[] };
  const {files,notes} = await snapshot(root,out);
  const issues:Issue[] = [];
  const shared = selected.some(m => m === 'security' || m === 'performance' || m === 'bugs' || m === 'errors');
  for (const file of files) {
    for (const scanner of scanners) issues.push(...scanner(file,files));
    if (shared) issues.push(...scanSignals(file,selected));
  }
  if (selected.includes('errors')) {
    const grammar = syntax(files);
    issues.push(...grammar.issues); notes.push(...grammar.notes);
  }
  if (selected.includes('errors') || selected.includes('security') || selected.includes('specialized')) {
    const tools = await scanTools(root,files,trusted,selected);
    issues.push(...tools.issues); notes.push(...tools.notes);
  }
  return {files,issues,notes};
}

interface ScanOptions {path?:string;repo?:string;url?:string;out:string;provider?:LLMProvider;trusted?:boolean;browser?:boolean;modules?:readonly Category[]}
export async function runScan(o:ScanOptions) {
  const modules = selectedModules(o.modules);
  const inspectSources = modules.some(m => m !== 'ui');
  const browser = modules.includes('ui') && o.browser !== false;
  if (o.url && !o.path && !o.repo && !browser) throw Error('Yalnız URL için ui modülü ve tarayıcı gerekir. Kaynak modülleri için --path veya --repo kullanın.');
  if (!inspectSources && !browser) throw Error('Yalnız ui modülü seçildi. Tarayıcıyı etkinleştirin.');
  if (o.path && o.repo) throw Error('Kaynak için --path veya --repo seçin. --url her ikisiyle de kullanılabilir.');
  if (o.repo && o.trusted) throw Error('Proje komutları için depoyu inceleyip yerel --path ile çalıştırın.');
  let address: string | undefined;
  if (o.url) {
    const u=new URL(o.url);
    if (!['http:','https:'].includes(u.protocol) || u.username || u.password) throw Error('Kimlik bilgisi içermeyen HTTP(S) URL gerekli.');
    address=u.href;
  }
  const remote=o.repo && (inspectSources || !address) ? await checkout(o.repo) : undefined;
  let server:Awaited<ReturnType<typeof preview>> | undefined;
  try {
    const root = remote?.root ?? (o.path || !address ? await realpath(o.path ?? '.') : undefined);
    if (root && !(await stat(root)).isDirectory()) throw Error('--path bir dizin olmalıdır.');
    const target:Target = {project:o.repo ? basename(new URL(o.repo).pathname).replace(/\.git$/,'') : root ? basename(root) : new URL(address!).hostname,
      root:remote ? undefined : root,repo:o.repo,url:address ? new URL(address).origin + new URL(address).pathname : undefined};
    const out=resolve(o.out);
    if (out===root) throw Error('Rapor dizini kaynak kökünden ayrı olmalıdır.');
    const {files,issues,notes} = root && inspectSources ? await staticAudit(root,out,o.trusted,modules) : {files:[],issues:[],notes:[]};
    const stack=technology(files);
    notes.unshift('Seçilen tarama modülleri: ' + modules.join(', ') + '.');
    if (root && inspectSources) notes.push('Statik kurallar yerel kaynak ve yapılandırmaları inceledi. Örüntü bulguları kod incelemesine yön verir.');
    if (!root && inspectSources) notes.push('Yalnız URL verildi. Kaynak gerektiren seçili modüller için --path veya --repo verin.');
    let staticPreview = false;
    let unavailable = false;
    if (root && !address && browser && o.trusted) {
      try {
        let manifest = files.find(f=>f.path==='package.json')?.text;
        if (!inspectSources) {
          const filename = resolve(root,'package.json');
          const info = await lstat(filename).catch(() => undefined);
          if (info?.isFile() && info.size <= 1_048_576) manifest = await readFile(filename,'utf8');
        }
        if (manifest) server = await startProject(root,manifest);
        if (server) {address=server.url; notes.push('Yerel uygulama geçici portta başlatıldı. Tarayıcı ölçümü bu geliştirme sunucusuna aittir.');}
      } catch { unavailable = true; notes.push('Yerel geliştirme sunucusu başlatılamadı. Çalışan uygulama için --url kullanın.'); }
    }
    if (root && !address && browser && (inspectSources ? files.some(f=>f.path==='index.html')
      : await lstat(resolve(root,'index.html')).then(s=>s.isFile(),()=>false))) {
      server=await preview(root); address=server.url;
      staticPreview=true;
      notes.push('index.html geçici bir yerel statik sunucuda açıldı. HTTP başlıkları bu önizleme sunucusuna aittir.');
    }
    if (address && browser) {
      try {
        const ui=await scanUI(address,out);
        issues.push(...ui.issues.filter(i=>modules.includes(i.category) && !(staticPreview && i.category==='security' && !i.file)));
        notes.push(...ui.notes);
        unavailable = ui.completed === 0;
      } catch {
        unavailable = true;
        notes.push('Playwright taraması başlatılamadı. Chromium kurulumu, sandbox ve rapor dizini izinlerini kontrol edin.');
      }
      if (unavailable) notes.push('İstenen tarayıcı denetimi tamamlanamadı. Sağlık puanı yalnız tamamlanan kontrollerdeki bulguları yansıtır.');
      if (!stack.length) stack.push('Web');
    } else if (modules.includes('ui')) {
      notes.push('Tarayıcı taraması çalışmadı. Çalışan uygulama için --url verin veya statik index.html kullanın.');
      if (!inspectSources) unavailable = true;
    }
    if (modules.includes('security') && o.provider && files.length) {
      try {const ai=await review(o.provider,files); issues.push(...ai.issues);notes.push(...ai.notes);}
      catch { notes.push('AI incelemesi tamamlanamadı. Sağlayıcı bağlantısını, modeli ve JSON yanıtını kontrol edin.'); }
    } else if (modules.includes('security')) notes.push('AI incelemesi çalışmadı.');
    const report: Report = { ...makeReport(target,stack,files.length,issues,notes), modules };
    const slug=(target.project.replace(/[^a-z0-9_-]+/gi,'-') || 'project').slice(0,64);
    const prefix=resolve(out,`d54-report-${slug}-${report.createdAt.replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);
    await mkdir(out,{recursive:true});
    await writeFile(prefix+'.md',markdown(report),{flag:'wx'});
    await writeFile(prefix+'.json',json(report),{flag:'wx'});
    return {report,prefix,unavailable};
  } finally {
    try { if (server) await server.close(); } finally { await remote?.cleanup(); }
  }
}
