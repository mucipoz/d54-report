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
  for (const path of [out,join(out,'screenshots'),join(out,'patches')]) {
    try { if (!(await lstat(path)).isDirectory()) throw Error('Rapor çıktı yolu bir dizin olmalıdır.'); }
    catch(e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
  }
}

server.registerTool('d54_scan_project',{
  title:'Audit a local project',
  description:'Scan local source and optionally a running page. Writes Markdown and JSON to the project reports directory.',
  inputSchema:{path:filePath,url:z.string().url().optional(),use_llm:z.boolean().default(false),modules:modules.optional()},
  outputSchema:{summary:summarySchema,report_paths:z.object({markdown:z.string(),json:z.string()}),
    critical_high:z.array(findingSchema),coverage:z.array(z.string()),browser_unavailable:z.boolean(),scan_incomplete:z.boolean(),modules},
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}
},async ({path,url,use_llm,modules:selected})=>{
  const root=await realpath(resolve(path)),out=join(root,'reports');
  await regularOutput(out);
  const provider=use_llm && (!selected || selected.includes('security')) ? await model() : undefined;
  const {report,prefix,unavailable,browserUnavailable}=await runScan({path:root,url,out,modules:selected,provider,trusted:await trusted(root)});
  return structured({summary:report.summary, report_paths:{markdown:prefix+'.md',json:prefix+'.json'},
    critical_high:report.findings.filter(f=>f.severity==='critical'||f.severity==='high'),coverage:report.coverage,
    modules:report.modules ?? [...categories],browser_unavailable:browserUnavailable,scan_incomplete:unavailable});
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

server.connect(new StdioServerTransport(process.stdin,wire)).catch(()=>{
  console.error('D54 Report MCP stdio bağlantısı başlatılamadı.');process.exitCode=1;
});
