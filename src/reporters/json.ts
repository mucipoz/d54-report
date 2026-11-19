import { severities, type Finding, type Issue, type Report, type Target } from '../types.js';

const prefixes = {errors:'ERR',security:'SEC',performance:'PERF',ui:'UI',bugs:'BUG',specialized:'SPEC'};
const weights = {critical:15,high:7,medium:3,low:1};
const caps = {critical:30,high:20,medium:10,low:5};
export function makeReport(target: Target, stack: string[], filesScanned: number, issues: Issue[], coverage: string[], createdAt = new Date().toISOString()): Report {
  const counts = {critical:0,high:0,medium:0,low:0};
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const sequence = new Map<string,number>();
  const key = (x: Issue) => JSON.stringify([x.category,x.file,x.url,x.viewport,x.selector,x.line,x.rule,x.title]);
  for (const item of [...issues].sort((a,b) => severities.indexOf(a.severity)-severities.indexOf(b.severity) || key(a).localeCompare(key(b),'en',{numeric:true}))) {
    const identity = key(item);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const n = (sequence.get(item.category) ?? 0)+1;
    sequence.set(item.category,n);
    counts[item.severity]++;
    findings.push({...item,id:prefixes[item.category]+'-'+String(n).padStart(3,'0')});
  }
  const penalty = severities.reduce((sum,s) => sum + Math.min(caps[s], counts[s]*weights[s]),0);
  return {schemaVersion:1,createdAt,target,stack,filesScanned,coverage:[...new Set(coverage)],
    summary:{total:findings.length,counts,health:Math.max(0,100-penalty)},findings,priority:findings.slice(0,5).map(f=>f.id)};
}
export const json = (report: Report) => JSON.stringify(report,null,2)+'\n';
