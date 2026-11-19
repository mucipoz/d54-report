import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { staticAudit } from '../src/engine.js';
import type { SourceFile } from '../src/types.js';
import { scan as security, maskSecrets } from '../src/scanners/security.js';
import { isTestPath } from '../src/scanners/static-utils.js';

const execFileAsync = promisify(execFile);

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

  it('jwt shaped dotted value stays high', () => {
    const fakeJwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1c2VyMSJ9', 'abc123def456'].join('.');
    const issues = secretIssues('src/auth.ts', `const token = "${fakeJwt}";`);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('high');
  });

  it('mapbox secret token stays high', () => {
    const fakeSk = ['sk', 'eyJ1Ijo1234567890', 'AbCd9876EfGh5432'].join('.');
    const issues = secretIssues('src/maps.ts', `const accessToken = "${fakeSk}";`);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('high');
  });
});

function fakeServiceAccountJson() {
  const header = '-----BEGIN ' + 'PRIVATE KEY-----';
  const footer = '-----END ' + 'PRIVATE KEY-----';
  return JSON.stringify({
    type: 'service_account',
    project_id: 'demo-project',
    private_key_id: 'key-1',
    private_key: `${header}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n${footer}\n`,
    client_email: 'demo@demo-project.iam.gserviceaccount.com',
  }, null, 2);
}

describe('git durumu', () => {
  it('tracked key is critical', async () => {
    const root = await mkdtemp(join(tmpdir(), 'd54-git-tracked-'));
    try {
      await writeFile(join(root, 'sa.json'), fakeServiceAccountJson());
      await execFileAsync('git', ['init'], { cwd: root });
      await execFileAsync('git', ['add', 'sa.json'], { cwd: root });
      const { issues } = await staticAudit(root, undefined, false, ['security']);
      const fileIssues = issues.filter(i => i.file === 'sa.json');
      expect(fileIssues).toHaveLength(1);
      expect(fileIssues[0]?.rule).toBe('security.service-account-key');
      expect(fileIssues[0]?.severity).toBe('critical');
      expect(fileIssues[0]?.evidence).not.toContain('MIIEvQIBADAN');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignored key is low', async () => {
    const root = await mkdtemp(join(tmpdir(), 'd54-git-ignored-'));
    try {
      await writeFile(join(root, '.gitignore'), 'sa.json\n');
      await writeFile(join(root, 'sa.json'), fakeServiceAccountJson());
      await execFileAsync('git', ['init'], { cwd: root });
      await execFileAsync('git', ['add', '.gitignore'], { cwd: root });
      const { issues } = await staticAudit(root, undefined, false, ['security']);
      const fileIssues = issues.filter(i => i.file === 'sa.json');
      expect(fileIssues).toHaveLength(1);
      expect(fileIssues[0]?.rule).toBe('security.service-account-key');
      expect(fileIssues[0]?.severity).toBe('low');
      expect(fileIssues[0]?.evidence).toBe("Yerel dosya, git'e girmemiş.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('non git root degrades', async () => {
    const root = await mkdtemp(join(tmpdir(), 'd54-nongit-'));
    try {
      await writeFile(join(root, 'sa.json'), fakeServiceAccountJson());
      const { issues } = await staticAudit(root, undefined, false, ['security']);
      const fileIssues = issues.filter(i => i.file === 'sa.json');
      expect(fileIssues).toHaveLength(1);
      expect(fileIssues[0]?.rule).toBe('security.service-account-key');
      expect(fileIssues[0]?.severity).toBe('high');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('service account file keeps other known credentials', () => {
    const header = '-----BEGIN ' + 'PRIVATE KEY-----';
    const footer = '-----END ' + 'PRIVATE KEY-----';
    const fakeAws = ['AKIA', 'X'.repeat(16)].join('');
    const json = JSON.stringify({
      type: 'service_account',
      private_key: `${header}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n${footer}\n`,
      extra_aws_key: fakeAws,
    }, null, 2);
    const keyLine = json.split('\n').findIndex(l => l.includes('"private_key"')) + 1;
    const file = source('sa.json', json);
    const issues = security(file, [file]);
    const saIssues = issues.filter(i => i.rule === 'security.service-account-key');
    const literalIssues = issues.filter(i => i.rule === 'security.literal-secret');
    expect(saIssues).toHaveLength(1);
    expect(literalIssues).toHaveLength(1);
    expect(literalIssues[0]?.severity).toBe('high');
    expect(literalIssues[0]?.line).not.toBe(keyLine);
  });
});

function sqlIssues(text: string, path = 'src/db.ts') {
  const file = source(path, text);
  return security(file, [file]).filter(i => i.rule === 'security.sql-construction');
}

describe('sql kuralı', () => {
  it('parameterized conditional is low', () => {
    const issues = sqlIssues('query(`SELECT * FROM t${id ? " WHERE id = ?" : ""}`, [id]);');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('low');
    expect(issues[0]?.evidence).toContain('Şablondaki ifadeler sabit; değerler parametreyle gönderiliyor.');
  });

  it('placeholder list is low', () => {
    const issues = sqlIssues('query(`INSERT INTO t (a) VALUES (${xs.map(() => "?").join(", ")})`, xs);');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('low');
  });

  it('dynamic identifier keeps high', () => {
    const issues = sqlIssues('query(`SELECT * FROM t ORDER BY ${req.query.sort}`, []);');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('high');
  });

  it('string concat keeps high', () => {
    const issues = sqlIssues('query("SELECT * FROM t WHERE a = \'" + name + "\'");');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('high');
  });

  it('missing params argument keeps high', () => {
    const issues = sqlIssues('query(`SELECT * FROM t${id ? " WHERE id = ?" : ""}`);');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('high');
  });

  it('constant column list is low while dynamic column list keeps high', () => {
    const safeIssues = sqlIssues('query(`SELECT ${["id", "name"].map(f => `\\`${f}\\``).join(", ")} FROM t WHERE id = ?`, [id]);');
    expect(safeIssues).toHaveLength(1);
    expect(safeIssues[0]?.severity).toBe('low');

    const unsafeIssues = sqlIssues('query(`SELECT ${cols.map(f => `\\`${f}\\``).join(", ")} FROM t WHERE id = ?`, [id]);');
    expect(unsafeIssues).toHaveLength(1);
    expect(unsafeIssues[0]?.severity).toBe('high');
  });
});
