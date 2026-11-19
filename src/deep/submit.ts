import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { readBoundedFile } from '../fs-guards.js';
import { makeReport } from '../reporters/json.js';
import { readReport } from '../reporters/read.js';
import { writeReport } from '../reporters/write.js';
import { severities, type Issue, type Report, type Severity } from '../types.js';
import { deepSensitive } from './chunk.js';
import { loadSession, sha256Text } from './session.js';

export const deepCategories = [
  'authz',
  'business-rule',
  'race',
  'async',
  'null',
  'logic',
  'boundary',
  'error-handling',
] as const;

export type DeepCategory = typeof deepCategories[number];

export const deepFindingSchema = z.object({
  category: z.enum(deepCategories),
  file: z.string().min(1),
  line: z.number().int().positive(),
  quote: z.string().min(1).max(400),
  title: z.string(),
  impact: z.string(),
  advice: z.string(),
  severity: z.enum(severities),
  verdict: z.enum(['confirmed', 'rejected', 'uncertain']),
  reason: z.string(),
});

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

function normalizeWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clipQuote(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 160 ? trimmed.slice(0, 159) + '…' : trimmed;
}

async function findLatestReportForRoot(outReal: string, rootReal: string): Promise<Report | undefined> {
  let names: string[];
  try {
    names = (await readdir(outReal)).filter(n => /^d54-report-.*\.json$/.test(n));
  } catch {
    return undefined;
  }
  const dated: { name: string; path: string; time: number }[] = [];
  for (const name of names) {
    const full = resolve(outReal, name);
    try {
      const info = await stat(full);
      if (info.isFile()) dated.push({ name, path: full, time: info.mtimeMs });
    } catch {
      // Silinen veya okunamayan rapor dosyası atlanır.
    }
  }
  dated.sort((a, b) => b.time - a.time || b.name.localeCompare(a.name, 'en'));
  for (const entry of dated) {
    try {
      const report = await readReport(entry.path);
      if (report.target.root === rootReal) return report;
    } catch {
      // Bozuk veya standart dışı dosya atlanır.
    }
  }
  return undefined;
}

export async function submitDeepReview(
  root: string,
  out: string,
  id: string,
  findings: unknown[],
  counts?: { uncertain?: number; rejected?: number },
): Promise<{
  accepted: number;
  rejected: { index: number; reason: string }[];
  report: Report;
  prefix: string;
}> {
  const rootReal = await realpath(resolve(root));
  const session = await loadSession(out, id);
  if (session.root !== rootReal) {
    throw Error('Oturum belirtilen kaynak dizinine ait değil.');
  }
  const outReal = await realpath(resolve(out));

  const sessionFileMap = new Map(session.files.map(f => [f.path, f.sha256]));
  const diskCache = new Map<string, { unchanged: boolean; lines: string[] }>();

  async function inspectCurrentFile(relPath: string, expectedHash: string): Promise<{ unchanged: boolean; lines: string[] }> {
    const cached = diskCache.get(relPath);
    if (cached) return cached;
    const full = resolve(rootReal, relPath);
    const rel = relative(rootReal, full);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      const res = { unchanged: false, lines: [] };
      diskCache.set(relPath, res);
      return res;
    }
    try {
      const text = (await readBoundedFile(full, MAX_SOURCE_BYTES)).toString('utf8');
      const unchanged = sha256Text(text) === expectedHash;
      const res = { unchanged, lines: unchanged ? text.split(/\r?\n/) : [] };
      diskCache.set(relPath, res);
      return res;
    } catch {
      const res = { unchanged: false, lines: [] };
      diskCache.set(relPath, res);
      return res;
    }
  }

  const prevReport = await findLatestReportForRoot(outReal, rootReal);
  const prevIssues: Issue[] = prevReport
    ? prevReport.findings.map(({ id: _id, triage: _triage, ...issue }) => issue)
    : [];
  const existingKeys = new Set(
    prevIssues
      .filter(i => i.file && i.line !== undefined && i.rule.startsWith('review.deep.'))
      .map(i => `${i.file}\0${i.line}\0${i.rule}`),
  );

  const rejected: { index: number; reason: string }[] = [];
  const acceptedIssues: Issue[] = [];
  const seenKeys = new Set<string>();

  for (let index = 0; index < findings.length; index++) {
    const parsed = deepFindingSchema.safeParse(findings[index]);
    if (!parsed.success) {
      rejected.push({ index, reason: 'şema geçersiz' });
      continue;
    }
    const item = parsed.data;

    if (item.verdict !== 'confirmed') {
      rejected.push({ index, reason: 'doğrulanmadı' });
      continue;
    }

    const expectedSha = sessionFileMap.get(item.file);
    if (!expectedSha) {
      rejected.push({ index, reason: 'bilinmeyen dosya' });
      continue;
    }

    const current = await inspectCurrentFile(item.file, expectedSha);
    if (!current.unchanged) {
      rejected.push({ index, reason: 'kaynak değişti' });
      continue;
    }

    const matchingChunks = session.chunks.filter(
      c => c.file === item.file && item.line >= c.start && item.line <= c.end,
    );
    if (!matchingChunks.length) {
      rejected.push({ index, reason: 'satır aralık dışı' });
      continue;
    }

    const currentLine = current.lines[item.line - 1] ?? '';
    if (matchingChunks.some(c => c.masked.includes(item.line)) || deepSensitive(currentLine)) {
      rejected.push({ index, reason: 'gizli satır' });
      continue;
    }

    const normQuote = normalizeWs(item.quote);
    if (normQuote.length < 8 || !/[\p{L}\p{N}]/u.test(normQuote)) {
      rejected.push({ index, reason: 'alıntı çok kısa' });
      continue;
    }
    if (!normalizeWs(currentLine).includes(normQuote)) {
      rejected.push({ index, reason: 'alıntı eşleşmiyor' });
      continue;
    }

    const prose = [item.title, item.impact, item.advice, item.reason];
    if (prose.some(t => !t.trim() || t.length > 800)) {
      rejected.push({ index, reason: 'metin boş veya çok uzun' });
      continue;
    }
    // Açıklamada "password"/"token" gibi ad geçmesi normal; yalnız gerçek sır değeri reddedilir.
    if (deepSensitive(item.quote) || prose.some(t => deepSensitive(t))) {
      rejected.push({ index, reason: 'metin sır deseni içeriyor' });
      continue;
    }

    const rule = 'review.deep.' + item.category;
    const dedupKey = `${item.file}\0${item.line}\0${rule}`;
    if (existingKeys.has(dedupKey)) {
      rejected.push({ index, reason: 'zaten raporlu' });
      continue;
    }
    if (seenKeys.has(dedupKey)) {
      rejected.push({ index, reason: 'tekrar' });
      continue;
    }
    seenKeys.add(dedupKey);

    const severity: Severity =
      item.severity === 'critical' && item.category !== 'authz' && item.category !== 'business-rule'
        ? 'high'
        : item.severity;

    acceptedIssues.push({
      category: item.category === 'authz' ? 'security' : 'bugs',
      rule,
      severity,
      title: 'Derin inceleme (ajan) · ' + item.title.trim(),
      file: item.file,
      line: item.line,
      evidence: 'Satır ' + item.line + ': ' + clipQuote(item.quote),
      impact: item.impact.trim(),
      advice: item.advice.trim(),
    });
  }

  const u = counts?.uncertain ?? 0;
  const r = counts?.rejected ?? 0;
  const deepNotes = [
    `Derin inceleme (ajan): ${acceptedIssues.length} kabul, ${rejected.length} ret, ajan bildirimi ${u} belirsiz / ${r} çürütülen.`,
    'Ajan doğrulamasını D54 Report kanıtlayamaz; satır ve alıntı denetimi yapıldı.',
  ];

  const baseMerged = makeReport(
    prevReport ? prevReport.target : { project: basename(rootReal), root: rootReal },
    prevReport ? prevReport.stack : [],
    prevReport ? prevReport.filesScanned : 0,
    [...prevIssues, ...acceptedIssues],
    [...(prevReport ? prevReport.coverage : []), ...deepNotes],
  );

  const report: Report = {
    ...baseMerged,
    ...(prevReport?.modules ? { modules: prevReport.modules } : {}),
    ...(prevReport?.suppressed !== undefined ? { suppressed: prevReport.suppressed } : {}),
    ...(prevReport?.suppressedKnownCredentials !== undefined
      ? { suppressedKnownCredentials: prevReport.suppressedKnownCredentials }
      : {}),
  };

  const prefix = await writeReport(outReal, report);
  return {
    accepted: acceptedIssues.length,
    rejected,
    report,
    prefix,
  };
}
