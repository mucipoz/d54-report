import ts from 'typescript';
import type { SourceFile } from '../types.js';

const lineBreaks = (input: string) => input.replace(/[^\n]/g, '');

// Only copy tokens recognized by the parser. Trivia, regex patterns, quoted
// values, JSX content and template bodies never enter the provider request.
function scriptOutline(file: SourceFile): string {
  const tree = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, false);
  if ((tree as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) return '';
  let end = 0;
  const chunks: string[] = [];
  const pending: ts.Node[] = [tree];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) continue;
    const literal = ts.isLiteralExpression(node) || ts.isTemplateExpression(node) ||
      ts.isJsxElement(node) || ts.isJsxFragment(node) || ts.isJsxSelfClosingElement(node);
    if (!literal) {
      const children = node.getChildren(tree);
      if (children.length) {
        for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
        continue;
      }
    }
    const start = node.getStart(tree);
    const gap = file.text.slice(end, start);
    chunks.push(/\S/.test(gap) ? ' ' + lineBreaks(gap) : gap);
    const raw = file.text.slice(start, node.end);
    chunks.push(literal ? '""' + lineBreaks(raw) : raw);
    end = node.end;
  }
  return chunks.join('');
}

// Keep a cross-line lexer state for Python, Rust and PHP literals and comments.
// For PHP heredocs or mixed templates, omit the file rather than interpreting markup as code.
function otherOutline(file: SourceFile): string {
  const source = file.text;
  const python = file.path.endsWith('.py'), rust = file.path.endsWith('.rs');
  if (!python && !rust && (/<<</.test(source) || !/^\s*<\?php\b/i.test(source) || /\?>[\s\S]*\S/.test(source))) return '';
  let quote = '', rawString = false, depth = 0;
  const openingRaw = /(?:br|cr|r)(#{0,255})"/y;
  const chunks: string[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\n') { chunks.push(ch); continue; }
    if (depth) {
      if (source.startsWith('*/', i)) { depth--; i++; }
      else if (rust && source.startsWith('/*', i)) { depth++; i++; }
      continue;
    }
    if (quote) {
      if (source.startsWith(quote, i)) { i += quote.length - 1; quote = ''; rawString = false; }
      else if (!rawString && ch === '\\' && source[i + 1] !== '\n') i++;
      continue;
    }
    if ((!rust && ch === '#') || (!python && source.startsWith('//', i))) {
      const newline = source.indexOf('\n', i);
      if (newline < 0) break;
      i = newline - 1;
      continue;
    }
    if (!python && source.startsWith('/*', i)) { depth = 1; i++; chunks.push(' '); continue; }
    if (rust && (ch === 'r' || ch === 'b' || ch === 'c')) {
      openingRaw.lastIndex = i;
      const match = openingRaw.exec(source);
      if (match) {
        quote = '"' + match[1]; rawString = true; i += match[0].length - 1; chunks.push('""'); continue;
      }
    }
    if (ch === '"' || ch === "'" || (!python && !rust && ch === '`')) {
      // Lifetimes and labels use a single apostrophe without a closing quote.
      if (rust && ch === "'" && /[\w]/.test(source[i + 1] ?? '') && source[i + 2] !== "'") { chunks.push(ch); continue; }
      quote = python && source.startsWith(ch.repeat(3),i) ? ch.repeat(3) : ch;
      i += quote.length - 1; chunks.push('""'); continue;
    }
    chunks.push(ch);
  }
  return chunks.join('');
}

export function structuralSource(file: SourceFile) {
  return /\.[cm]?[jt]sx?$/.test(file.path) ? scriptOutline(file) : otherOutline(file);
}
