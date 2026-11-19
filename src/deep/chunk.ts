import ts from 'typescript';
import type { SourceFile } from '../types.js';
import { RISK_KEYWORDS } from './select.js';

export interface Chunk {
  file: string;
  start: number;
  end: number;
  name: string;
}

export interface RenderedChunkBlock {
  text: string;
  masked: number[];
  used: Chunk[];
}

const TS_JS_EXT = /\.(?:tsx?|jsx?|mjs|cjs)$/i;
const RISK_KEYWORD_RE = new RegExp(RISK_KEYWORDS.join('|'), 'i');

const PEM_HEADER_RE = /-----(?:BEGIN|END) [^\r\n-]*?(?:PRIVATE KEY|SECRET|CERTIFICATE|KEY)-----/i;
const PEM_BEGIN_RE = /-----BEGIN [^\r\n-]*?(?:PRIVATE KEY|SECRET|KEY)-----/i;
const PEM_END_RE = /-----END [^\r\n-]*?(?:PRIVATE KEY|SECRET|KEY)-----/i;
const AUTH_SCHEME_RE = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i;
const SK_PREFIX_RE = /\b[sr]k_(?:live|test)_/;
const KEY_LITERAL_RE = /['"][A-Za-z0-9+/=_-]{24,}['"]/;
const SECRET_ASSIGN_RE = /\b[A-Za-z0-9_$]*(?:pass|pwd|secret|token|api_?key|credential)[A-Za-z0-9_$]*["']?\s*[:=]\s*['"`][^'"`\r\n]+['"`]/i;
const URL_CRED_RE = /:\/\/[^\s/'"]+:[^\s/'"]+@/;

export function deepSensitive(line: string): boolean {
  return (
    PEM_HEADER_RE.test(line) ||
    AUTH_SCHEME_RE.test(line) ||
    SK_PREFIX_RE.test(line) ||
    KEY_LITERAL_RE.test(line) ||
    SECRET_ASSIGN_RE.test(line) ||
    URL_CRED_RE.test(line)
  );
}

function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

function isFunctionLikeExpr(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
  if (ts.isCallExpression(e)) {
    return e.arguments.some(arg => ts.isExpression(arg) && (ts.isArrowFunction(unwrap(arg)) || ts.isFunctionExpression(unwrap(arg))));
  }
  return false;
}

function propLabel(name: ts.PropertyName | undefined, sf: ts.SourceFile): string {
  if (!name) return 'anonymous';
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  return name.getText(sf).slice(0, 48);
}

function nodeRange(node: ts.Node, sf: ts.SourceFile): [number, number] {
  const startPos = node.getStart(sf);
  const endPos = Math.max(startPos, node.getEnd() - 1);
  return [
    sf.getLineAndCharacterOfPosition(startPos).line + 1,
    sf.getLineAndCharacterOfPosition(endPos).line + 1,
  ];
}

function collectObjectChunks(obj: ts.ObjectLiteralExpression, prefix: string, sf: ts.SourceFile, file: string, out: Chunk[]): void {
  for (const prop of obj.properties) {
    if (ts.isMethodDeclaration(prop) || ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
      const [start, end] = nodeRange(prop, sf);
      out.push({ file, start, end, name: `${prefix}.${propLabel(prop.name, sf)}` });
    } else if (ts.isPropertyAssignment(prop)) {
      const name = `${prefix}.${propLabel(prop.name, sf)}`;
      const init = unwrap(prop.initializer);
      if (ts.isObjectLiteralExpression(init)) {
        collectObjectChunks(init, name, sf, file, out);
      } else if (isFunctionLikeExpr(init)) {
        const [start, end] = nodeRange(prop, sf);
        out.push({ file, start, end, name });
      }
    }
  }
}

function collectClassChunks(cls: ts.ClassLikeDeclaration, className: string, sf: ts.SourceFile, file: string, out: Chunk[]): void {
  for (const member of cls.members) {
    if (
      ts.isMethodDeclaration(member) ||
      ts.isConstructorDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
    ) {
      if (!member.body) continue;
      const label = ts.isConstructorDeclaration(member) ? 'constructor' : propLabel(member.name, sf);
      const [start, end] = nodeRange(member, sf);
      out.push({ file, start, end, name: `${className}.${label}` });
    }
  }
}

function extractTsChunks(file: SourceFile): Chunk[] {
  const sf = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, false);
  const raw: Chunk[] = [];

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      const [start, end] = nodeRange(stmt, sf);
      raw.push({ file: file.path, start, end, name: stmt.name?.text ?? 'default' });
    } else if (ts.isClassDeclaration(stmt)) {
      collectClassChunks(stmt, stmt.name?.text ?? 'Class', sf, file.path, raw);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!decl.initializer) continue;
        const varName = ts.isIdentifier(decl.name) ? decl.name.text : decl.name.getText(sf).slice(0, 48);
        let init = unwrap(decl.initializer);
        if (ts.isCallExpression(init) && init.arguments.length === 1 && ts.isObjectLiteralExpression(unwrap(init.arguments[0]!))) {
          init = unwrap(init.arguments[0]!);
        }
        if (ts.isObjectLiteralExpression(init)) {
          collectObjectChunks(init, varName, sf, file.path, raw);
        } else if (isFunctionLikeExpr(init)) {
          const targetNode = stmt.declarationList.declarations.length === 1 ? stmt : decl;
          const [start, end] = nodeRange(targetNode, sf);
          raw.push({ file: file.path, start, end, name: varName });
        }
      }
    } else if (ts.isExportAssignment(stmt)) {
      const expr = unwrap(stmt.expression);
      if (ts.isObjectLiteralExpression(expr)) {
        collectObjectChunks(expr, 'default', sf, file.path, raw);
      } else if (ts.isClassExpression(expr)) {
        collectClassChunks(expr, expr.name?.text ?? 'default', sf, file.path, raw);
      } else if (isFunctionLikeExpr(expr)) {
        const [start, end] = nodeRange(stmt, sf);
        raw.push({ file: file.path, start, end, name: 'default' });
      }
    } else if (ts.isExpressionStatement(stmt)) {
      const expr = unwrap(stmt.expression);
      if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const lhs = expr.left.getText(sf).slice(0, 64);
        const rhs = unwrap(expr.right);
        if (ts.isObjectLiteralExpression(rhs)) {
          collectObjectChunks(rhs, lhs, sf, file.path, raw);
        } else if (isFunctionLikeExpr(rhs)) {
          const [start, end] = nodeRange(stmt, sf);
          raw.push({ file: file.path, start, end, name: lhs });
        }
      } else if (ts.isCallExpression(expr) && isFunctionLikeExpr(expr)) {
        const [start, end] = nodeRange(stmt, sf);
        raw.push({ file: file.path, start, end, name: expr.expression.getText(sf).slice(0, 64) });
      }
    }
  }

  return raw;
}

function splitChunkWindows(chunk: Chunk, windowSize: number, overlap: number): Chunk[] {
  const len = chunk.end - chunk.start + 1;
  if (len <= windowSize) return [chunk];
  const stride = Math.max(1, windowSize - overlap);
  const out: Chunk[] = [];
  let part = 1;
  for (let s = chunk.start; s <= chunk.end; s += stride) {
    const e = Math.min(chunk.end, s + windowSize - 1);
    out.push({ file: chunk.file, start: s, end: e, name: `${chunk.name}#${part++}` });
    if (e >= chunk.end) break;
  }
  return out;
}

function intersects(start: number, end: number, ranges: ReadonlyArray<[number, number]>): boolean {
  for (const [rStart, rEnd] of ranges) {
    if (start <= rEnd && rStart <= end) return true;
  }
  return false;
}

function chunkHasRisk(chunk: Chunk, lines: readonly string[]): boolean {
  if (RISK_KEYWORD_RE.test(chunk.name)) return true;
  const maxIdx = Math.min(lines.length, chunk.end);
  for (let i = Math.max(0, chunk.start - 1); i < maxIdx; i++) {
    if (RISK_KEYWORD_RE.test(lines[i]!)) return true;
  }
  return false;
}

export function chunkFile(file: SourceFile, changed?: Array<[number, number]>): Chunk[] {
  if (!file.text) return [];
  const lines = file.text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const totalLines = lines.length;
  if (totalLines === 0) return [];

  let windows: Chunk[] = [];
  if (TS_JS_EXT.test(file.path)) {
    const raw = extractTsChunks(file);
    if (raw.length > 0) {
      for (const c of raw) {
        if (changed && !intersects(c.start, c.end, changed)) continue;
        for (const w of splitChunkWindows(c, 300, 20)) {
          if (!changed || intersects(w.start, w.end, changed)) windows.push(w);
        }
      }
    } else if (!changed || intersects(1, totalLines, changed)) {
      for (const w of splitChunkWindows({ file: file.path, start: 1, end: totalLines, name: 'module' }, 300, 20)) {
        if (!changed || intersects(w.start, w.end, changed)) windows.push(w);
      }
    }
  } else {
    for (let s = 1, part = 1; s <= totalLines; s += 200, part++) {
      const e = Math.min(totalLines, s + 199);
      if (!changed || intersects(s, e, changed)) {
        windows.push({ file: file.path, start: s, end: e, name: `pencere-${part}` });
      }
    }
  }

  const decorated = windows.map(chunk => ({
    chunk,
    risk: chunkHasRisk(chunk, lines) ? 1 : 0,
    len: chunk.end - chunk.start + 1,
  }));

  decorated.sort((a, b) => b.risk - a.risk || b.len - a.len || a.chunk.start - b.chunk.start);
  return decorated.map(d => d.chunk);
}

function findPemLines(lines: readonly string[]): Set<number> {
  const set = new Set<number>();
  let inPem = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (PEM_BEGIN_RE.test(line)) inPem = true;
    if (inPem) set.add(i + 1);
    if (inPem && PEM_END_RE.test(line)) inPem = false;
  }
  return set;
}

function makeHeader(file: string, name: string, start: number, end: number): string {
  return `### ${file} · ${name} · ${start}-${end}`;
}

export function renderChunksWithStats(
  file: SourceFile,
  chunks: Chunk[],
  maxChars: number,
): { blocks: RenderedChunkBlock[]; skippedMasked: number } {
  const limit = Math.max(200, maxChars);
  const lines = file.text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const pemLines = findPemLines(lines);

  const blocks: RenderedChunkBlock[] = [];
  let skippedMasked = 0;

  let curParts: string[] = [];
  let curLen = 0;
  let curMasked: number[] = [];
  let curUsed: Chunk[] = [];

  const flush = () => {
    if (!curParts.length) return;
    blocks.push({
      text: curParts.join('\n\n'),
      masked: [...new Set(curMasked)].sort((a, b) => a - b),
      used: curUsed,
    });
    curParts = [];
    curLen = 0;
    curMasked = [];
    curUsed = [];
  };

  const appendSegment = (segText: string, segMasked: number[], segChunk: Chunk) => {
    const sepLen = curParts.length > 0 ? 2 : 0;
    if (curParts.length > 0 && curLen + sepLen + segText.length > limit) {
      flush();
    }
    const nextSep = curParts.length > 0 ? 2 : 0;
    curParts.push(segText);
    curLen += nextSep + segText.length;
    curMasked.push(...segMasked);
    curUsed.push(segChunk);
  };

  for (const chunk of chunks) {
    const start = Math.max(1, chunk.start);
    const end = Math.min(lines.length, chunk.end);
    if (start > end) continue;

    const total = end - start + 1;
    const chunkMasked: number[] = [];
    const formattedLines: string[] = [];

    for (let ln = start; ln <= end; ln++) {
      const raw = lines[ln - 1] ?? '';
      const isMasked = pemLines.has(ln) || deepSensitive(raw);
      if (isMasked) {
        chunkMasked.push(ln);
        formattedLines.push(`${ln}| <gizli satır>`);
      } else {
        formattedLines.push(`${ln}| ${raw}`);
      }
    }

    if (chunkMasked.length / total > 0.3) {
      skippedMasked++;
      continue;
    }

    const fullHeader = makeHeader(file.path, chunk.name, start, end);
    const fullText = `${fullHeader}\n${formattedLines.join('\n')}`;

    if (fullText.length <= limit) {
      appendSegment(fullText, chunkMasked, { file: file.path, start, end, name: chunk.name });
      continue;
    }

    // Single chunk exceeds maxChars: split by lines so every block stays <= maxChars.
    flush();
    let subStart = start;
    let subLines: string[] = [];
    let subBodyLen = 0;

    const emitSub = (subEnd: number) => {
      if (!subLines.length) return;
      const hdr = makeHeader(file.path, chunk.name, subStart, subEnd);
      const subMasked = chunkMasked.filter(ln => ln >= subStart && ln <= subEnd);
      const text = `${hdr}\n${subLines.join('\n')}`;
      blocks.push({
        text: text.length <= limit ? text : text.slice(0, limit - 1) + '…',
        masked: subMasked,
        used: [{ file: file.path, start: subStart, end: subEnd, name: chunk.name }],
      });
      subLines = [];
      subBodyLen = 0;
    };

    for (let i = 0; i < formattedLines.length; i++) {
      const ln = start + i;
      let fLine = formattedLines[i]!;
      const maxHeaderProbe = makeHeader(file.path, chunk.name, ln, end).length + 1;
      if (maxHeaderProbe + fLine.length > limit) {
        fLine = fLine.slice(0, Math.max(20, limit - maxHeaderProbe - 1)) + '…';
      }
      const nextBodyLen = subLines.length === 0 ? fLine.length : subBodyLen + 1 + fLine.length;
      const hdrLen = makeHeader(file.path, chunk.name, subStart, ln).length + 1;
      if (subLines.length > 0 && hdrLen + nextBodyLen > limit) {
        emitSub(ln - 1);
        subStart = ln;
        subLines.push(fLine);
        subBodyLen = fLine.length;
      } else {
        subLines.push(fLine);
        subBodyLen = nextBodyLen;
      }
    }
    emitSub(end);
  }

  flush();
  return { blocks, skippedMasked };
}

export function renderChunks(file: SourceFile, chunks: Chunk[], maxChars: number): RenderedChunkBlock[] {
  return renderChunksWithStats(file, chunks, maxChars).blocks;
}
