#!/usr/bin/env node
import { Writable } from 'node:stream';
import { Console } from 'node:console';
import { realpath, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { categories, severities } from './types.js';
import { findingSchema, findingId, summarySchema, readMarkdown, readReport } from './reporters/read.js';
import { runScan, verifyRescan, verifySourceRescan } from './engine.js';
import { runFix } from './fixer/index.js';
import { loadProvider } from './llm/provider.js';
import { prepareDeepReview } from './deep/session.js';
import { submitDeepReview } from './deep/submit.js';
import { loadDeepContextFile, runDeepReviewApi } from './deep/api.js';

// Keep the original stdout writer exclusively for the SDK transport.
// Scanner/library console output, raw stdout.write and Node warnings go to stderr.
const protocolWrite=process.stdout.write.bind(process.stdout);
const wire=new Writable({write(chunk,encoding,next) {protocolWrite(chunk,encoding,next);}});
process.stdout.write=process.stderr.write.bind(process.stderr);
globalThis.console=new Console({stdout:process.stderr,stderr:process.stderr});

const server=new McpServer({name:'d54-report',version:'0.1.0'});
const filePath=z.string().trim().min(1).max(8192);
const modules=z.array(z.enum(categories)).min(1).max(categories.length);
const verification=z.object({stage:z.string(),status:z.enum(['passed','failed','skipped']),detail:z.string().optional()});
const resultSchema=z.object({id:findingId,status:z.string(),detail:z.string().optional(),patchPath:z.string().optional(),verification:z.array(verification).optional()});

async function trusted(root:string) {
  const configured=process.env.D54_MCP_TRUSTED_ROOT;
  return !!configured && root===await realpath(configured);
}
async function model() {
  const config=process.env.D54_MCP_CONFIG;
  const provider=await loadProvider(config,!config);
  if (!provider) throw Error('Model istendi. Sunucunun D54_PROVIDER, D54_MODEL veya D54_MCP_CONFIG ayarlarını tanımlayın.');
  return provider;
}
function structured<T extends Record<string, unknown>>(value:T) {
  return {structuredContent:value,content:[{type:'text' as const,text:JSON.stringify(value)}]};
}
async function regularOutput(out:string) {
  for (const path of [out,join(out,'screenshots'),join(out,'patches'),join(out,'deep')]) {
    try { if (!(await lstat(path)).isDirectory()) throw Error('Rapor çıktı yolu bir dizin olmalıdır.'); }
    catch(e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
  }
}

function clip(text:string, limit=200) {
  return text.length>limit ? text.slice(0,limit-1)+'…' : text;
}

server.registerTool('d54_scan_project',{
  title:'Audit a local project',
  description:'Scan local source and optionally a running page. Writes Markdown and JSON to the project reports directory.',
  inputSchema:{path:filePath,url:z.string().url().optional(),use_llm:z.boolean().default(false),triage:z.boolean().default(false),modules:modules.optional()},
  outputSchema:{summary:summarySchema,report_paths:z.object({markdown:z.string(),json:z.string()}),
    critical_high:z.array(findingSchema),critical_high_total:z.number().int().nonnegative(),
    rule_counts:z.record(z.string(),z.number().int().nonnegative()),
    coverage:z.array(z.string()),browser_unavailable:z.boolean(),scan_incomplete:z.boolean(),modules,
    suppressed:z.number().int().nonnegative().optional(),
    suppressedKnownCredentials:z.number().int().nonnegative().optional()},
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}
},async ({path,url,use_llm,triage,modules:selected})=>{
  if (triage && !use_llm) throw Error('triage için use_llm: true gerekir.');
  const root=await realpath(resolve(path)),out=join(root,'reports');
  await regularOutput(out);
  const provider=use_llm && (!selected || selected.includes('security') || triage) ? await model() : undefined;
  const {report,prefix,unavailable,browserUnavailable}=await runScan({path:root,url,out,modules:selected,provider,triage,trusted:await trusted(root)});
  const criticalHighAll=report.findings
    .filter(f=>f.severity==='critical'||f.severity==='high')
    .sort((a,b)=>
      (a.severity===b.severity ? 0 : a.severity==='critical' ? -1 : 1) ||
      a.rule.localeCompare(b.rule) ||
      (a.file??'').localeCompare(b.file??'') ||
      (a.line??0)-(b.line??0));
  const rule_counts:Record<string,number>={};
  for (const f of report.findings) {
    if (f.severity==='critical' || f.severity==='high' || f.severity==='medium') {
      rule_counts[f.rule]=(rule_counts[f.rule]??0)+1;
    }
  }
  const coverage=report.suppressedKnownCredentials && report.suppressedKnownCredentials>0
    ? [...report.coverage, `Bastırma dosyası ${report.suppressedKnownCredentials} gerçek biçimli anahtarı gizledi.`]
    : report.coverage;
  return structured({summary:report.summary, report_paths:{markdown:prefix+'.md',json:prefix+'.json'},
    critical_high:criticalHighAll.slice(0,25).map(f=>({...f,evidence:clip(f.evidence),impact:clip(f.impact),advice:clip(f.advice),...(f.triage?{triage:{verdict:f.triage.verdict,reason:clip(f.triage.reason)}}:{})})),
    critical_high_total:criticalHighAll.length,rule_counts,coverage,
    modules:report.modules ?? [...categories],browser_unavailable:browserUnavailable,scan_incomplete:unavailable,
    ...(report.suppressed!==undefined ? {suppressed:report.suppressed} : {}),
    ...(report.suppressedKnownCredentials!==undefined ? {suppressedKnownCredentials:report.suppressedKnownCredentials} : {})});
});

async function approvePR(root:string,patches:{id:string;file:string;patchPath:string}[]): Promise<boolean> {
  if (process.env.D54_MCP_ALLOW_PR==='1' && await trusted(root)) return true;
  if (!server.server.getClientCapabilities()?.elicitation) return false;
  const reply=await server.server.elicitInput({mode:'form',
    message:`D54 Report: ${root} için aşağıdaki doğrulanmış yamalarla dal, commit, push ve taslak PR oluşturulsun mu?\n`+
      patches.map(p=>`${p.id} · ${p.file} · ${p.patchPath}`).join('\n'),
    requestedSchema:{type:'object',properties:{approve:{type:'boolean',title:'Taslak PR yayımlamayı onayla',default:false}},required:['approve']}});
  return reply.action==='accept' && reply.content?.approve===true;
}
function list(value:string|string[]|undefined) {
  return typeof value==='string' ? value.split(',').map(s=>s.trim()) : value;
}
server.registerTool('d54_fix_findings',{
  title:'Prepare verified fixes',
  description:'Export patches or open an approved draft PR for findings from a local D54 JSON report. Dry run previews candidates.',
  inputSchema:{report_path:filePath,mode:z.enum(['patch','pr']).default('patch'),
    severity:z.union([z.string().min(1),z.array(z.enum(severities)).min(1)]).optional(),
    ids:z.union([z.string().min(1),z.array(findingId).min(1)]).optional(),dry_run:z.boolean().default(false)},
  outputSchema:{patch_paths:z.array(z.string()),successful:z.array(resultSchema),rolled_back:z.array(resultSchema),results:z.array(resultSchema)},
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}
},async ({report_path,mode,severity,ids,dry_run})=>{
  const path=resolve(report_path), report=await readReport(path);
  if (!report.target.root || !isAbsolute(report.target.root)) throw Error('Düzeltme için yerel proje dizini içeren bir rapor gerekir.');
  const root=await realpath(report.target.root),out=await realpath(dirname(path));
  const selected=list(ids), levels=list(severity);
  if (selected?.some(id=>!report.findings.some(f=>f.id===id))) throw Error('Seçilen ID raporda bulunamadı.');
  if (levels?.some(level=>!severities.includes(level as typeof severities[number]))) throw Error('Geçersiz önem filtresi.');
  await regularOutput(out);
  const allowChecks=await trusted(root);
  const results=await runFix({root,out,report,mode,dryRun:dry_run,force:false,yes:false,approvePR:patches=>approvePR(root,patches),
    trusted:allowChecks,ids:selected,severity:levels,provider:!dry_run && process.env.D54_MCP_FIX_LLM==='1' ? await model() : undefined,
    allowCandidatePrompt:false,sourceRescan:(dir,target)=>verifySourceRescan(dir,report.modules,target),
    rescan:(dir,target)=>verifyRescan(dir,allowChecks,report.modules,target)});
  return structured({patch_paths:[...new Set(results.flatMap(r=>r.patchPath?[r.patchPath]:[]))],
    successful:results.filter(r=>['PATCH_CREATED','PR_CREATED','DRY_RUN'].includes(r.status)),
    rolled_back:results.filter(r=>r.status==='FIX_FAILED (Rollback)'),results});
});

server.registerTool('d54_get_report',{
  title:'Read a D54 Markdown report',
  description:'Return the complete saved Markdown from its .md file or the companion of a JSON report.',
  inputSchema:{report_path:filePath},annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:false}
},async ({report_path})=>({content:[{type:'text',text:await readMarkdown(resolve(report_path))}]}));

server.registerTool('d54_deep_review_prepare',{
  title:'Prepare deep logic review chunks for agent verification',
  description:'Select high-risk files, chunk functions, mask secrets, and write numbered chunk files into the project reports directory without calling an external model.',
  inputSchema:{
    path:filePath,
    since:z.string().trim().min(1).max(100).optional(),
    deep_files:z.number().int().min(1).max(20).optional(),
    max_chunks:z.number().int().min(1).max(200).optional(),
  },
  outputSchema:{
    session:z.string(),
    chunk_files:z.array(z.string()),
    summary:z.object({
      files:z.array(z.string()),
      chunks:z.number().int().nonnegative(),
      skippedMasked:z.number().int().nonnegative(),
      notes:z.array(z.string()),
    }),
    instructions:z.string(),
  },
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}
},async ({path,since,deep_files,max_chunks})=>{
  const root=await realpath(resolve(path)),out=join(root,'reports');
  await regularOutput(out);
  const res=await prepareDeepReview(root,out,{since,files:deep_files,maxChunks:max_chunks});
  return structured({session:res.session,chunk_files:res.chunkFiles,summary:res.summary,instructions:res.instructions});
});

server.registerTool('d54_deep_review_submit',{
  title:'Validate and merge agent-verified deep review findings',
  description:'Verify line ranges, file SHA-256 hashes, unmasked quotes, and severity caps for confirmed deep review findings and merge them into a D54 report.',
  inputSchema:{
    path:filePath,
    session:z.string().trim().min(1).max(64),
    findings:z.array(z.unknown()).max(200),
    uncertain:z.number().int().nonnegative().optional(),
    rejected:z.number().int().nonnegative().optional(),
  },
  outputSchema:{
    accepted:z.number().int().nonnegative(),
    rejected:z.array(z.object({index:z.number().int().nonnegative(),reason:z.string()})),
    summary:summarySchema,
    report_paths:z.object({markdown:z.string(),json:z.string()}),
  },
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}
},async ({path,session,findings,uncertain,rejected})=>{
  const root=await realpath(resolve(path)),out=join(root,'reports');
  await regularOutput(out);
  const res=await submitDeepReview(root,out,session,findings,{uncertain,rejected});
  return structured({
    accepted:res.accepted,
    rejected:res.rejected,
    summary:res.report.summary,
    report_paths:{markdown:res.prefix+'.md',json:res.prefix+'.json'},
  });
});

function mcpDeepMaxBudget() {
  const raw=process.env.D54_MCP_DEEP_MAX_BUDGET;
  if (raw===undefined || !raw.trim()) return 40;
  const trimmed=raw.trim();
  if (!/^\d+$/.test(trimmed)) throw Error('D54_MCP_DEEP_MAX_BUDGET 2 ile 200 arasında bir tam sayı olmalıdır.');
  const n=Number(trimmed);
  if (!Number.isInteger(n) || n<2) throw Error('D54_MCP_DEEP_MAX_BUDGET 2 ile 200 arasında bir tam sayı olmalıdır.');
  return Math.min(200,n);
}

server.registerTool('d54_deep_review_run',{
  title:'Run API-backed deep logic review',
  description:'Run deep logic discovery and skeptical verification against the configured LLM provider (incurs API cost) and merge confirmed findings into a D54 report.',
  inputSchema:{
    path:filePath,
    since:z.string().trim().min(1).max(100).optional(),
    files:z.number().int().min(1).max(20).optional(),
    budget:z.number().int().min(2).max(200).optional(),
  },
  outputSchema:{
    accepted:z.number().int().nonnegative(),
    rejected:z.array(z.object({index:z.number().int().nonnegative(),reason:z.string()})),
    summary:summarySchema,
    report_paths:z.object({markdown:z.string(),json:z.string()}),
    notes:z.array(z.string()).optional(),
    usage:z.object({
      calls:z.number().int().nonnegative(),
      inputTokens:z.number().int().nonnegative(),
      outputTokens:z.number().int().nonnegative(),
      model:z.string(),
      candidates:z.number().int().nonnegative(),
      confirmed:z.number().int().nonnegative(),
      rejected:z.number().int().nonnegative(),
      uncertain:z.number().int().nonnegative(),
      unreadable:z.number().int().nonnegative(),
      unverified:z.number().int().nonnegative(),
    }),
  },
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}
},async ({path,since,files,budget})=>{
  // shortcut: MCP iptal sinyali runDeepReviewApi'ye geçmiyor, uzun koşularda extra.signal eklenmeli
  const maxBudget=mcpDeepMaxBudget();
  const effectiveBudget=budget!==undefined ? Math.min(budget,maxBudget) : maxBudget;
  const context=await loadDeepContextFile();
  const notes:string[]=[];
  if (budget!==undefined && budget>maxBudget) {
    notes.push(`MCP bütçe tavanı (${maxBudget}) nedeniyle istenen bütçe (${budget}) ${effectiveBudget} ile sınırlandı.`);
  }
  const provider=await model();
  const root=await realpath(resolve(path)),out=join(root,'reports');
  await regularOutput(out);
  const res=await runDeepReviewApi(root,out,provider,{since,files,budget:effectiveBudget,notes,context});
  return structured({
    accepted:res.accepted,
    rejected:res.submitRejected,
    summary:res.report.summary,
    report_paths:{markdown:res.prefix+'.md',json:res.prefix+'.json'},
    ...(notes.length ? { notes } : {}),
    usage:{
      calls:res.calls,
      inputTokens:res.inputTokens,
      outputTokens:res.outputTokens,
      model:res.model,
      candidates:res.candidates,
      confirmed:res.confirmed,
      rejected:res.rejected,
      uncertain:res.uncertain,
      unreadable:res.unreadable,
      unverified:res.unverified,
    },
  });
});

server.connect(new StdioServerTransport(process.stdin,wire)).catch(()=>{
  console.error('D54 Report MCP stdio bağlantısı başlatılamadı.');process.exitCode=1;
});
