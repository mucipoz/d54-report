#!/usr/bin/env node
import { Command } from 'commander';
import { readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runScan, verifyRescan, verifySourceRescan } from './engine.js';
import { loadProvider } from './llm/provider.js';
import { runFix } from './fixer/index.js';
import { severities } from './types.js';
import { readReport } from './reporters/read.js';
import { readBoundedFile } from './fs-guards.js';
import { prepareDeepReview } from './deep/session.js';
import { submitDeepReview } from './deep/submit.js';
import { loadDeepContextFile, runDeepReviewApi } from './deep/api.js';

const app = new Command().name('d54-report').version('0.1.0').description('Kaynak kodu ve arayüz denetimi / Software audit and approved fixes');
function common(cmd:Command) {
  return cmd.option('--path <dir>','yerel kaynak dizini').option('--out <dir>','rapor dizini','reports')
    .option('--no-llm','model yapılandırmasını ve tüm model çağrılarını atla')
    .option('--config <file>','operatörün D54 model yapılandırması')
    .option('--trusted','incelenmiş yerel projenin build, test ve araç komutlarına izin ver')
    .option('--json','standart çıktıya yalnız JSON yaz');
}

common(app.command('scan').description('Statik analiz ve tarayıcı denetimi'))
  .option('--repo <github-url>').option('--url <http-url>').option('--no-browser','statik site önizlemesini ve Playwright taramasını atla')
  .option('--fail-on-critical','kritik bulguda 2 ile çık')
  .option('--triage','kritik ve yüksek bulguları model ile triyaj et')
  .action(async o => {
    if (o.url && o.browser === false) throw Error('--url ve --no-browser birlikte kullanılamaz.');
    if (o.triage && !o.llm) throw Error('--triage, --no-llm ile birlikte kullanılamaz.');
    const provider = o.llm ? await loadProvider(o.config) : undefined;
    if (o.triage && !provider) throw Error('--triage için model yapılandırması gerekir (d54-report.config.json veya D54_PROVIDER/D54_MODEL)');
    const {report,prefix,unavailable} = await runScan({...o,provider});
    console.log(o.json ? JSON.stringify(report) : `${report.summary.total} bulgu · ${report.summary.health}/100\n${prefix}.md\n${prefix}.json`);
    if (o.failOnCritical && report.summary.counts.critical) process.exitCode=2;
    else if (unavailable) process.exitCode=1;
  });

async function selectReport(out:string,root:string,explicit?:string) {
  if (explicit) return readReport(explicit);
  const names=(await readdir(out)).filter(n=>/^d54-report-.*\.json$/.test(n));
  const dated=await Promise.all(names.map(async name=>({path:resolve(out,name),time:(await stat(resolve(out,name))).mtimeMs})));
  for (const entry of dated.sort((a,b)=>b.time-a.time)) {
    const report=await readReport(entry.path);
    if (report.target.root===root) return report;
  }
  throw Error('Bu yerel kaynak için scan çalıştırın veya --report ile raporu seçin.');
}
function filter(value?:string) {
  if (value === undefined) return;
  const items=value.split(',').map(s=>s.trim());
  if (items.some(s=>!s)) throw Error('Boş filtre geçersiz. Virgülle ayrılmış değerler girin.');
  return items;
}
common(app.command('fix').description('Yama öner, onayla ve doğrula'))
  .option('--report <file>','scan JSON dosyası').option('--mode <mode>','patch | interactive | pr','patch')
  .option('--ids <list>').option('--severity <list>').option('--dry-run').option('--force','kirli çalışma alanını koruyarak devam et')
  .option('--yes','PR dalı, doğrulanmış commit ve draft PR için açık onay')
  .action(async o=>{
    if (!['patch','interactive','pr'].includes(o.mode)) throw Error('Geçersiz düzeltme modu.');
    if (o.json && o.mode==='interactive') throw Error('Etkileşimli modu terminalde --json olmadan kullanın.');
    const root=await realpath(o.path ?? '.');
    const report=await selectReport(resolve(o.out),root,o.report);
    const severity=filter(o.severity), ids=filter(o.ids);
    if (severity?.some(s=>!severities.includes(s as typeof severities[number]))) throw Error('Geçersiz önem filtresi.');
    if (ids?.some(id=>!report.findings.some(f=>id===f.id))) throw Error('Seçilen ID raporda bulunamadı.');
    const results=await runFix({root,report,out:resolve(o.out),mode:o.mode,dryRun:!!o.dryRun,force:!!o.force,yes:!!o.yes,
      severity,ids,trusted:!!o.trusted,allowCandidatePrompt:!o.json,provider:o.llm && !o.dryRun ? await loadProvider(o.config) : undefined,
      rescan:(dir,target)=>verifyRescan(dir,!!o.trusted,report.modules,target),
      sourceRescan:(dir,target)=>verifySourceRescan(dir,report.modules,target)});
    console.log(o.json ? JSON.stringify({schemaVersion:1,results}) : results.map(x=>[x.id,x.status,x.detail].filter(Boolean).join(' · ')).join('\n') || 'Filtreyle eşleşen bulgu yok.');
    if (results.some(x=>x.status.includes('FAILED'))) process.exitCode=1;
  });

function parseIntFlag(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw.trim())) throw Error(`${flag} pozitif bir tam sayı olmalıdır.`);
  return Number(raw.trim());
}

const deep = app.command('deep').description('Derin mantık ve işlevsellik incelemesi (ajan modu)');
deep.command('prepare').description('Riskli dosyaları parçalayıp ajan incelemesi için hazırla')
  .requiredOption('--path <dir>', 'yerel kaynak dizini')
  .option('--since <ref>', 'yalnız belirtilen git referansından bu yana değişen aralıklar')
  .option('--files <n>', 'incelenecek en çok dosya sayısı (1..20)')
  .option('--max-chunks <n>', 'üretilecek en çok parça sayısı (1..200)')
  .option('--out <dir>', 'rapor dizini', 'reports')
  .action(async o => {
    const root = await realpath(o.path);
    const files = o.files !== undefined ? parseIntFlag(o.files, '--files') : undefined;
    const maxChunks = o.maxChunks !== undefined ? parseIntFlag(o.maxChunks, '--max-chunks') : undefined;
    const res = await prepareDeepReview(root, resolve(o.out), { since: o.since, files, maxChunks });
    console.log(JSON.stringify(res));
  });

deep.command('submit').description('Ajanın doğruladığı derin inceleme bulgularını denetleyip rapora birleştir')
  .requiredOption('--path <dir>', 'yerel kaynak dizini')
  .requiredOption('--session <id>', 'prepare çıktısındaki 16 karakterlik oturum kimliği')
  .requiredOption('--findings <json>', 'bulguları içeren JSON dosya yolu')
  .option('--out <dir>', 'rapor dizini', 'reports')
  .action(async o => {
    const root = await realpath(o.path);
    const raw = (await readBoundedFile(resolve(o.findings), 16 * 1024 * 1024)).toString('utf8');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw Error('--findings geçerli bir JSON dosyası olmalıdır.'); }
    let items: unknown[];
    let counts: { uncertain?: number; rejected?: number } | undefined;
    if (Array.isArray(parsed)) {
      items = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { findings?: unknown }).findings)) {
      const obj = parsed as { findings: unknown[]; uncertain?: unknown; rejected?: unknown };
      items = obj.findings;
      counts = {
        ...(typeof obj.uncertain === 'number' && Number.isInteger(obj.uncertain) && obj.uncertain >= 0 ? { uncertain: obj.uncertain } : {}),
        ...(typeof obj.rejected === 'number' && Number.isInteger(obj.rejected) && obj.rejected >= 0 ? { rejected: obj.rejected } : {}),
      };
    } else {
      throw Error('--findings bir JSON dizisi veya {"findings":[...]} nesnesi içermelidir.');
    }
    if (items.length > 200) throw Error('En çok 200 bulgu gönderilebilir.');
    const res = await submitDeepReview(root, resolve(o.out), o.session, items, counts);
    console.log(JSON.stringify({
      accepted: res.accepted,
      rejected: res.rejected,
      summary: res.report.summary,
      report_paths: { markdown: res.prefix + '.md', json: res.prefix + '.json' },
    }));
  });

deep.command('run').description('Riskli dosyaları yapılandırılmış model API ile incele, doğrula ve rapora birleştir')
  .requiredOption('--path <dir>', 'yerel kaynak dizini')
  .option('--since <ref>', 'yalnız belirtilen git referansından bu yana değişen aralıklar')
  .option('--files <n>', 'incelenecek en çok dosya sayısı (1..20)')
  .option('--budget <n>', 'en çok model çağrısı bütçesi (2..200)', '40')
  .option('--context <file>', 'operatörün güvenilir mimari bağlam notu dosyası (en çok 4096 bayt)')
  .option('--candidates-out <file>', 'aday günlüğünü JSON olarak kaydet')
  .option('--config <file>', 'operatörün D54 model yapılandırması')
  .option('--out <dir>', 'rapor dizini', 'reports')
  .action(async o => {
    const budget = parseIntFlag(o.budget, '--budget');
    if (budget < 2 || budget > 200) throw Error('Bütçe 2 ile 200 arasında bir tam sayı olmalıdır.');
    const context = await loadDeepContextFile(o.context);
    const provider = await loadProvider(o.config);
    if (!provider) throw Error('Derin inceleme API modu için D54_PROVIDER/D54_MODEL/D54_API_KEY gerekir.');
    const root = await realpath(o.path);
    const files = o.files !== undefined ? parseIntFlag(o.files, '--files') : undefined;
    const res = await runDeepReviewApi(root, resolve(o.out), provider, { since: o.since, files, budget, context });
    if (o.candidatesOut) {
      const candidatesPath = resolve(o.candidatesOut);
      const outputLog = res.candidateLog.map(c => ({
        file: c.file,
        line: c.line,
        category: c.category,
        title: c.title,
        verdict: c.verdict,
        ...(c.dropReason ? { dropReason: c.dropReason } : {}),
      }));
      await writeFile(candidatesPath, JSON.stringify(outputLog, null, 2) + '\n', 'utf8');
    }
    console.log(JSON.stringify({
      accepted: res.accepted,
      rejected: res.submitRejected,
      summary: res.report.summary,
      report_paths: { markdown: res.prefix + '.md', json: res.prefix + '.json' },
      usage: {
        calls: res.calls,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        model: res.model,
        candidates: res.candidates,
        confirmed: res.confirmed,
        rejected: res.rejected,
        uncertain: res.uncertain,
        unreadable: res.unreadable,
        unverified: res.unverified,
      },
    }));
  });

app.parseAsync().catch((error:Error)=>{ console.error('D54 · '+error.message.replace(/[\r\n\x1b]/g,' ').slice(0,480));process.exitCode=1; });
