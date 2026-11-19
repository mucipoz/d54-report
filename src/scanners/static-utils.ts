import { posix } from 'node:path';
import ts from 'typescript';
import type { Issue, SourceFile } from '../types.js';

export const isScript = (path: string) => /\.[cm]?[jt]sx?$/i.test(path);

export function isTestPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return /(?:^|\/)(?:tests?|__tests__|fixtures?|e2e)\//i.test(normalized)
    || /[.-](?:test|spec)\.[cm]?[jt]sx?$/i.test(normalized)
    || /-test\.[cm]?js$/i.test(normalized);
}
let cachedFile: SourceFile | undefined;
let cachedTree: ts.SourceFile | undefined;
const indexes = new WeakMap<readonly SourceFile[], ReadonlySet<string>>();

export function pathsOf(files: readonly SourceFile[]): ReadonlySet<string> {
  let paths = indexes.get(files);
  if (!paths) {
    paths = new Set(files.map(file => posix.normalize(file.path)));
    indexes.set(files, paths);
  }
  return paths;
}

export function treeOf(file: SourceFile): ts.SourceFile {
  if (cachedFile !== file || !cachedTree) {
    cachedFile = file;
    cachedTree = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
  }
  return cachedTree;
}

export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  const stack = [node];
  while (stack.length) {
    const next = stack.pop()!;
    visit(next);
    ts.forEachChild(next, child => { stack.push(child); });
  }
}

export function lineOf(node: ts.Node): number {
  const tree = node.getSourceFile();
  return tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
}

export function report(file: SourceFile, line: number, category: Issue['category'],
  rule: string, severity: Issue['severity'], title: string, evidence: string,
  impact: string, advice: string): Issue {
  return { file: file.path, line, category, rule, severity, title, evidence, impact, advice };
}

export function scanLines(file: SourceFile, check: (line: string, number: number) => void): void {
  file.text.split(/\r?\n/).forEach((line, index) => check(line, index + 1));
}
