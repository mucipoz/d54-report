export const severities = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = typeof severities[number];
export const categories = ['errors', 'security', 'performance', 'ui', 'bugs', 'specialized'] as const;
export type Category = typeof categories[number];
export interface SourceFile { path: string; text: string; size: number }
export interface Issue {
  rule: string;
  category: Category;
  severity: Severity;
  title: string;
  file?: string;
  line?: number;
  url?: string;
  selector?: string;
  viewport?: string;
  screenshot?: string;
  evidence: string;
  impact: string;
  advice: string;
}
export interface Finding extends Issue { id: string }
export interface Target { project: string; root?: string; repo?: string; url?: string }
export interface Report {
  schemaVersion: 1;
  modules?: Category[];
  createdAt: string;
  target: Target;
  stack: string[];
  filesScanned: number;
  coverage: string[];
  summary: { total: number; counts: Record<Severity, number>; health: number };
  findings: Finding[];
  priority: string[];
  suppressed?: number;
  suppressedKnownCredentials?: number;
}
