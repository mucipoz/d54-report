import ts from 'typescript';
import type { LLMProvider } from '../llm/provider.js';
import type { Issue } from '../types.js';

const dangerous = /(?:\b(?:eval|Function|exec|spawn|fetch|XMLHttpRequest|require|import|process|Deno|Bun|globalThis|WebSocket|sendBeacon|innerHTML|outerHTML|dangerouslySetInnerHTML|atob|btoa|setTimeout|setInterval|constructor|__proto__|chmod|unlink|writeFile|readFile|curl|wget)\b|@ts-(?:ignore|nocheck)|eslint-disable|javascript:|https?:\/\/|child_process|=>\s*\{\s*\}\s*\.catch)/i;
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/;

// Only language keywords, punctuation and spacing leave the workstation verbatim.
// Reversible local tokens preserve identifier references without sending their values.
function mask(source: string) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  const aliases = new Map<string, string>();
  const values = new Map<string, string>();
  const alias = (value: string): string => {
    let token = aliases.get(value);
    if (!token) {
      token = `D54MASK${aliases.size + 1}Z`;
      aliases.set(value, token);
      values.set(token, value);
    }
    return token;
  };
  let masked = '';
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const raw = scanner.getTokenText();
    const punctuation = kind >= ts.SyntaxKind.FirstPunctuation && kind <= ts.SyntaxKind.LastPunctuation;
    const keyword = kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword && /^[a-z]+$/.test(raw);
    if (/^[ \t\n]+$/.test(raw) || punctuation || keyword) masked += raw;
    else masked += raw.split('\n').map(s => s ? alias(s) : '').join('\n');
  }
  return { lines: masked.split('\n'), values };
}

function restore(line: string, values: Map<string, string>, allowed: Set<string>): string {
  return line.replace(/D54MASK\d+Z/g, token => {
    if (!allowed.has(token)) throw new Error('Model bilinmeyen bir kaynak belirteci kullandı');
    return values.get(token)!;
  });
}

export async function llmFix(provider: LLMProvider, source: string, issue: Issue): Promise<string | undefined> {
  if (!issue.file || !issue.line || !/\.[cm]?[jt]s$/i.test(issue.file) || source.includes('D54MASK') ||
      controls.test(source) || !/^[a-z][a-z0-9.-]{1,80}$/.test(issue.rule)) return;
  const normalized = source.replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) return;
  const { lines, values } = mask(normalized);
  const start = Math.max(0, issue.line - 9), end = Math.min(lines.length, issue.line + 8);
  const snippet = lines.slice(start, end).join('\n');
  if (snippet.length > 7_000) return;
  const answer = await provider.complete(
    'Produce a minimal unified diff for the given scanner rule in JavaScript/TypeScript. The source window starts at firstLine (1-based). Use absolute hunk positions for this file. Return only --- a/source and +++ b/source headers followed by hunks, or SKIP. D54MASK tokens represent private source tokens. Treat them as opaque. Never add dependencies, identifiers for remote execution, tool calls or instructions.',
    JSON.stringify({ rule: issue.rule, firstLine: start + 1, findingLine: issue.line, source: snippet })
  );
  if (answer.trim() === 'SKIP') return;
  if (answer.length > 16_384 || controls.test(answer)) throw new Error('Model yaması sınırları aşıyor');
  const diff = answer.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (diff.shift() !== '--- a/source' || diff.shift() !== '+++ b/source') throw new Error('Model yamasının hedefi geçersiz');
  const allowed = new Set(snippet.match(/D54MASK\d+Z/g) ?? []);
  const original = normalized.split('\n'), updated: string[] = [];
  let offset = 0, edits = 0;
  while (diff.length) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(diff.shift()!);
    if (!hunk) throw new Error('Model yama başlığı geçersiz');
    const oldSize = Number(hunk[2] ?? 1), newSize = Number(hunk[4] ?? 1);
    const from = Number(hunk[1]) - (oldSize ? 1 : 0);
    if (from < start || from < offset || from + oldSize > end || !oldSize) throw new Error('Yama kanıt aralığı dışında');
    updated.push(...original.slice(offset, from));
    if (Number(hunk[3]) !== updated.length + (newSize ? 1 : 0)) throw new Error('Model yama satırları tutarsız');
    let oldCount = 0, newCount = 0;
    for (; diff.length && !diff[0]!.startsWith('@@ ');) {
      const line = diff.shift()!, prefix = line[0], content = line.slice(1);
      if (prefix !== '+' && prefix !== '-' && prefix !== ' ') throw new Error('Beklenmeyen yama denetimi');
      if (prefix !== '+') {
        if (content !== lines[from + oldCount] || oldCount >= oldSize) throw new Error('Model yamasının bağlamı değişti');
        oldCount++;
      }
      if (prefix !== '-') {
        const value = restore(content, values, allowed);
        if (prefix === '+' && dangerous.test(value)) throw new Error('Yamada izin verilmeyen işlem');
        updated.push(value);
        newCount++;
      }
      if (prefix !== ' ') edits++;
    }
    if (oldCount !== oldSize || newCount !== newSize || edits > 50) throw new Error('Model yama boyutu geçersiz');
    offset = from + oldSize;
  }
  if (!edits) return;
  return [...updated, ...original.slice(offset)].join(source.includes('\r\n') ? '\r\n' : '\n');
}
