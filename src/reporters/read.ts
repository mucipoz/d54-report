import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { z } from 'zod';
import { categories, severities, type Report } from '../types.js';

export const findingId = z.string().regex(/^(?:SEC|UI|ERR|PERF|SPEC|BUG)-\d{3,}$/);
export const findingSchema = z.object({
  id:findingId, rule:z.string(), category:z.enum(categories), severity:z.enum(severities), title:z.string(),
  file:z.string().optional(), line:z.number().int().positive().optional(), url:z.string().optional(),
  selector:z.string().optional(), viewport:z.string().optional(), screenshot:z.string().optional(),
  evidence:z.string(), impact:z.string(), advice:z.string()
});
const count = z.number().int().nonnegative();
export const summarySchema = z.object({ total:count, health:count.max(100), counts:z.object({critical:count,high:count,medium:count,low:count}) });
const reportSchema = z.object({
  schemaVersion:z.literal(1),createdAt:z.string(),target:z.object({project:z.string(),root:z.string().optional(),url:z.string().optional(),repo:z.string().optional()}),
  stack:z.array(z.string()),filesScanned:count,coverage:z.array(z.string()),summary:summarySchema,
  findings:z.array(findingSchema),priority:z.array(findingId),modules:z.array(z.enum(categories)).optional()
});

async function textFile(path:string) {
  const handle=await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info=await handle.stat();
    if (!info.isFile() || info.size>64*1024*1024) throw Error('Standart bir D54 rapor dosyası gerekli (en çok 64 MiB).');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
export async function readReport(path:string):Promise<Report> {
  if (extname(path)!=='.json') throw Error('Bir D54 JSON raporu seçin.');
  const raw=await textFile(path);
  try {
    const report=reportSchema.parse(JSON.parse(raw));
    if (new Set(report.findings.map(f=>f.id)).size!==report.findings.length) throw Error();
    return report;
  } catch {throw Error('Geçersiz D54 JSON raporu.');}
}
export async function readMarkdown(path:string) {
  const ext=extname(path);
  if (ext!=='.json' && ext!=='.md') throw Error('Bir D54 Markdown veya JSON raporu seçin.');
  if (ext==='.json') await readReport(path);
  const body=await textFile(ext==='.json' ? path.slice(0,-5)+'.md' : path);
  if (!body.startsWith('# D54 Report · ') || !body.includes('\n## Yönetici özeti\n') || !body.includes('\n## Öncelikli aksiyon planı\n')) throw Error('Geçersiz D54 Markdown raporu.');
  return body;
}
