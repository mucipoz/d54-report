#!/usr/bin/env node
import { Command } from 'commander';
import { readdir, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runScan, staticAudit } from './engine.js';
import { loadProvider } from './llm/provider.js';
import { runFix } from './fixer/index.js';
import { severities } from './types.js';
import { readReport } from './reporters/read.js';

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
  .action(async o => {
    if (o.url && o.browser === false) throw Error('--url ve --no-browser birlikte kullanılamaz.');
    const {report,prefix,unavailable} = await runScan({...o,provider:o.llm ? await loadProvider(o.config) : undefined});
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
function filter(value?:string) {return value?.split(',').map(s=>s.trim()).filter(Boolean);}
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
      severity,ids,trusted:!!o.trusted,provider:o.llm && !o.dryRun ? await loadProvider(o.config) : undefined,
      rescan:async dir=>(await staticAudit(dir,undefined,!!o.trusted,report.modules)).issues});
    console.log(o.json ? JSON.stringify({schemaVersion:1,results}) : results.map(x=>[x.id,x.status,x.detail].filter(Boolean).join(' · ')).join('\n') || 'Filtreyle eşleşen bulgu yok.');
    if (results.some(x=>x.status.includes('FAILED'))) process.exitCode=1;
  });

app.parseAsync().catch((error:Error)=>{ console.error('D54 · '+error.message.replace(/[\r\n\x1b]/g,' ').slice(0,480));process.exitCode=1; });
