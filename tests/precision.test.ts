import { describe, expect, it } from 'vitest';
import type { SourceFile } from '../src/types.js';
import { scan as security, maskSecrets } from '../src/scanners/security.js';
import { isTestPath } from '../src/scanners/static-utils.js';

function source(path: string, text: string): SourceFile {
  return { path, text, size: Buffer.byteLength(text) };
}

function secretIssues(path: string, text: string) {
  const file = source(path, text);
  return security(file, [file]).filter(i => i.rule === 'security.literal-secret');
}

describe('şifre kuralı', () => {
  it('ignores public prefixes', () => {
    const pkVal = ['pk', 'a'.repeat(20)].join('.');
    expect(secretIssues('.env.production', 'NEXT_PUBLIC_API_KEY=abcdef123456')).toEqual([]);
    expect(secretIssues('app.json', `{"mapboxPublicToken": "${pkVal}"}`)).toEqual([]);
    expect(secretIssues('.env', 'EXPO_PUBLIC_TOKEN=abcdef123456\nVITE_API_KEY=abcdef123456')).toEqual([]);
    expect(secretIssues('src/auth.ts', 'const config = { clientId: "123-abc.apps.googleusercontent.com", apiKey: "123-abc.apps.googleusercontent.com", publicKey: "abcdef123456" };')).toEqual([]);
  });

  it('ignores route and label values', () => {
    expect(secretIssues('src/routes.ts', 'const routes = { "/reset-password": "Şifre Sıfırlama" };\nconst password = "/reset-password";')).toEqual([]);
    expect(secretIssues('src/i18n.ts', 'const labels = { token: "users.verifyEmailToken", password: "Şifremi unuttum" };')).toEqual([]);
  });

  it('downgrades test files', () => {
    const issues = secretIssues('scripts/foo-test.cjs', 'const password = "hunter2hunter2";');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('low');
  });

  it('ci service password low', () => {
    const workflow = [
      'jobs:',
      '  test:',
      '    services:',
      '      db:',
      '        env:',
      '          MARIADB_ROOT_PASSWORD: integration-only',
    ].join('\n');
    const issues = secretIssues('.github/workflows/ci.yml', workflow);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('low');
  });

  it('keeps real looking secret in app code high', () => {
    const fakeKey = ['Zx9', 'kL2mP8qR4tV7wY1z'].join('');
    const issues = secretIssues('src/config.ts', `const apiKey = "${fakeKey}";`);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('high');
  });

  it('known credential in test file stays high', () => {
    const fakeAws = ['AKIA', 'X'.repeat(16)].join('');
    const issues = secretIssues('tests/a.test.ts', `const key = "${fakeAws}";`);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('high');
  });

  it('masks known and literal credentials via maskSecrets', () => {
    const fakeAws = ['AKIA', 'X'.repeat(16)].join('');
    expect(maskSecrets(`const aws = "${fakeAws}";`)).toBe('const aws = "<gizli>";');
    expect(maskSecrets('const apiKey = "Zx9kL2mP8qR4tV7w";')).toBe('const apiKey = "<gizli>";');
    expect(maskSecrets('const publicKey = "Zx9kL2mP8qR4tV7w";')).toBe('const publicKey = "Zx9kL2mP8qR4tV7w";');
  });

  it('detects test paths via isTestPath', () => {
    expect(isTestPath('tests/a.test.ts')).toBe(true);
    expect(isTestPath('scripts/foo-test.cjs')).toBe(true);
    expect(isTestPath('src/foo.spec.tsx')).toBe(true);
    expect(isTestPath('src/config.ts')).toBe(false);
  });
});
