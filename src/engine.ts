import { basename, resolve } from 'node:path';
import { lstat, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { snapshot, technology } from './source.js';
import { gitState } from './git-state.js';
import { checkout, githubRepoUrl, preview } from './targets.js';
import { ensureOutputDirectory, readBoundedFile } from './fs-guards.js';
import { startProject } from './project-preview.js';
import { categories, type Category, type Issue, type Report, type SourceFile, type Target } from './types.js';
import { scan as errors } from './scanners/errors.js';
import { scan as security } from './scanners/security.js';
import { scan as performance } from './scanners/performance.js';
import { scan as bugs } from './scanners/bugs.js';
import { scan as specialized } from './scanners/specialized.js';
import { scanTools, type ToolCompletion } from './scanners/tooling.js';
import { scanSignals } from './scanners/review-signals.js';
import { syntax } from './scanners/syntax.js';
import { scanUI } from './scanners/ui-design.js';
import { review } from './llm/review.js';
import type { LLMProvider } from './llm/provider.js';
import { json, makeReport } from './reporters/json.js';
import { markdown } from './reporters/markdown.js';
import { applySuppressions, loadSuppressions } from './suppress.js';

const sourceScanners = { errors, security, performance, bugs, specialized };
function selectedModules(input: readonly Category[] = categories): Category[] {
  if (!input.length || input.some(m => !categories.includes(m))) throw Error('En az bir geçerli tarama modülü seçin.');
  return [...new Set(input)];
}

export async function staticAudit(root:string, out?:string, trusted=false, modules?:readonly Category[]) {
  return collectStatic(root, out, trusted, modules, true);
}

async function collectStatic(root: string, out: string | undefined, trusted: boolean, modules: readonly Category[] | undefined, externalTools: boolean) {
  const selected = selectedModules(modules);
  const scanners = selected.flatMap(m => m === 'ui' ? [] : [sourceScanners[m]]);
  let pythonCompleted = new Set<string>();
  let toolCompletion: ToolCompletion[] = [];
  if (!scanners.length) return { files: [] as SourceFile[], issues: [] as Issue[], notes: [] as string[], pythonCompleted, toolCompletion };
  const {files,notes} = await snapshot(root,out);
  const issues:Issue[] = [];
  const shared = selected.some(m => m === 'security' || m === 'performance' || m === 'bugs' || m === 'errors');
  for (const file of files) {
    for (const scanner of scanners) for (const issue of scanner(file,files)) issues.push(issue);
    if (shared) for (const issue of scanSignals(file,selected)) issues.push(issue);
  }
  if (selected.includes('errors')) {
    const grammar = syntax(files,root);
    pythonCompleted = grammar.pythonCompleted;
    issues.push(...grammar.issues); notes.push(...grammar.notes);
  }
  if (externalTools && (selected.includes('errors') || selected.includes('security') || selected.includes('specialized'))) {
    const tools = await scanTools(root,files,trusted,selected);
    toolCompletion = tools.completion;
    issues.push(...tools.issues); notes.push(...tools.notes);
  }
  const serviceAccountIssues = issues.filter(i => i.rule === 'security.service-account-key' && i.file);
  if (serviceAccountIssues.length) {
    const git = await gitState(root);
    if (git) {
      for (const issue of serviceAccountIssues) {
        const filePath = issue.file!;
        if (git.tracked.has(filePath)) issue.severity = 'critical';
        else if (await git.isIgnored(filePath)) {
          issue.severity = 'low';
          issue.evidence = "Yerel dosya, git'e girmemiş.";
        }
      }
    }
  }
  return {files,issues,notes,pythonCompleted,toolCompletion};
}

export async function verifyRescan(root: string, trusted: boolean, modules: readonly Category[] | undefined, target?: Issue): Promise<Issue[]> {
  const scan = await staticAudit(root, undefined, trusted, modules);
  return verifyCoverage(scan,modules,target,true);
}

export async function verifySourceRescan(root: string, modules: readonly Category[] | undefined, target?: Issue): Promise<Issue[]> {
  const scan = await collectStatic(root, undefined, false, modules, false);
  return verifyCoverage(scan,modules,target,false);
}

function verifyCoverage(scan: Awaited<ReturnType<typeof collectStatic>>, modules: readonly Category[] | undefined, target: Issue | undefined, requireToolCompletion: boolean): Issue[] {
  if (!target) return scan.issues;
  const advisory = /^security\.advisory-(npm|cargo|pip|composer)$/.exec(target.rule)?.[1];
  const file = scan.files.find(f => f.path === target.file);
  if (!file || target.rule.startsWith('review.') || (!advisory && file.size > 0 && !file.text) || (modules && !modules.includes(target.category))) {
    throw Error('Hedef kaynak veya modül yeniden taramada incelenemedi.');
  }
  if (target.rule === 'errors.syntax-python' && !scan.pythonCompleted.has(file.path)) throw Error('Hedef dosya için Python AST doğrulaması tamamlanamadı.');
  // Export-only model candidates receive source checks. Full verification also requires the target tool.
  if (requireToolCompletion && (advisory || ['errors.tool-failure','specialized.tool-failure'].includes(target.rule))) {
    let tasks = advisory ? scan.toolCompletion.filter(t => t.audit === advisory && t.file === file.path)
      : scan.toolCompletion.filter(t => !t.audit && t.label + ' başarısız' === target.title);
    // PHP syntax checks have a file per invocation. Other compilers can report across projects.
    if (!advisory && tasks[0]?.label === 'PHP sözdizimi') tasks = tasks.filter(t => t.file === file.path);
    if (!tasks.length || tasks.some(t => !t.complete)) throw Error('Hedef araca ait eksiksiz bir yeniden tarama sonucu alınamadı.');
  }
  return scan.issues;
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
  const repoUrl = o.repo ? githubRepoUrl(o.repo) : undefined;
  let address: string | undefined;
  if (o.url) {
    const u=new URL(o.url);
    if (!['http:','https:'].includes(u.protocol) || u.username || u.password) throw Error('Kimlik bilgisi içermeyen HTTP(S) URL gerekli.');
    address=u.href;
  }
  const remote=repoUrl && (inspectSources || !address) ? await checkout(repoUrl) : undefined;
  let server:Awaited<ReturnType<typeof preview>> | undefined;
  try {
    const root = remote?.root ?? (o.path || !address ? await realpath(o.path ?? '.') : undefined);
    if (root && !(await stat(root)).isDirectory()) throw Error('--path bir dizin olmalıdır.');
    const target:Target = {project:repoUrl ? basename(new URL(repoUrl).pathname).replace(/\.git$/,'') : root ? basename(root) : new URL(address!).hostname,
      root:remote ? undefined : root,repo:repoUrl,url:address ? new URL(address).origin + new URL(address).pathname : undefined};
    const out=resolve(o.out);
    if (out===root) throw Error('Rapor dizini kaynak kökünden ayrı olmalıdır.');
    await ensureOutputDirectory(out);
    const {files,issues,notes}: { files:SourceFile[]; issues:Issue[]; notes:string[] } =
      root && inspectSources ? await staticAudit(root,out,o.trusted,modules) : {files:[],issues:[],notes:[]};
    const stack=technology(files);
    notes.unshift('Seçilen tarama modülleri: ' + modules.join(', ') + '.');
    const sourceUnavailable = !!root && inspectSources && !files.length;
    if (sourceUnavailable) notes.push('Desteklenen bir kaynak dosyası okunamadı. Kaynak denetimi tamamlanamadı.');
    else if (root && inspectSources) notes.push('Statik kurallar yerel kaynak ve yapılandırmaları inceledi. Örüntü bulguları kod incelemesine yön verir.');
    if (!root && inspectSources) notes.push('Yalnız URL verildi. Kaynak gerektiren seçili modüller için --path veya --repo verin.');
    let staticPreview = false;
    let unavailable = false;
    if (root && !address && browser && o.trusted) {
      try {
        let manifest = files.find(f=>f.path==='package.json')?.text;
        if (!inspectSources) {
          const filename = resolve(root,'package.json');
          const info = await lstat(filename).catch(() => undefined);
          if (info?.isFile() && info.size <= 1_048_576) manifest = (await readBoundedFile(filename,1_048_576)).toString('utf8');
        }
        if (manifest) server = await startProject(root,manifest);
        if (server) {address=server.url; notes.push('Yerel uygulama geçici portta başlatıldı. Tarayıcı ölçümü bu geliştirme sunucusuna aittir.');}
      } catch { unavailable = true; notes.push('Yerel geliştirme sunucusu başlatılamadı. Çalışan uygulama için --url kullanın.'); }
    }
    if (root && !address && browser && (inspectSources ? files.some(f=>f.path==='index.html')
      : await lstat(resolve(root,'index.html')).then(s=>s.isFile(),()=>false))) {
      server=await preview(root,out); address=server.url;
      staticPreview=true;
      notes.push('index.html geçici bir yerel statik sunucuda açıldı. HTTP başlıkları bu önizleme sunucusuna aittir.');
    }
    if (address && browser) {
      try {
        const ui=await scanUI(address,out,!repoUrl);
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
    let keptIssues = issues;
    let suppressedCount = 0;
    let suppressedKnownCredentials = 0;
    if (root) {
      const { rules, notes: suppressNotes } = await loadSuppressions(root);
      notes.push(...suppressNotes);
      if (rules.length) {
        const applied = applySuppressions(issues, rules);
        keptIssues = applied.kept;
        suppressedCount = applied.suppressed;
        suppressedKnownCredentials = applied.suppressedKnownCredentials;
      }
    }
    if (target.root) {
      const git = await gitState(target.root);
      if (git && !(await git.isIgnored('reports/x'))) {
        notes.push("reports/ klasörü git tarafından dışlanmıyor. .gitignore'a 'reports/' ekleyin.");
      }
    }
    const report: Report = {
      ...makeReport(target, stack, files.length, keptIssues, notes),
      modules,
      ...(suppressedCount > 0 ? { suppressed: suppressedCount } : {}),
      ...(suppressedKnownCredentials > 0 ? { suppressedKnownCredentials } : {}),
    };
    const slug=(target.project.replace(/[^a-z0-9_-]+/gi,'-') || 'project').slice(0,64);
    const prefix=resolve(out,`d54-report-${slug}-${report.createdAt.replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);
    await ensureOutputDirectory(out);
    await writeFile(prefix+'.md',markdown(report),{flag:'wx',mode:0o600});
    try { await writeFile(prefix+'.json',json(report),{flag:'wx',mode:0o600}); }
    catch (error) { await rm(prefix+'.md',{force:true}); throw error; }
    return {report,prefix,unavailable:unavailable || sourceUnavailable,browserUnavailable:unavailable};
  } finally {
    try { if (server) await server.close(); } finally { await remote?.cleanup(); }
  }
}
