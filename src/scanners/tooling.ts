import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { categories, type Category, type Issue, type SourceFile } from '../types.js';
import { pathsOf } from './static-utils.js';
import { prepareAudit } from './audit-input.js';

type Audit = 'npm' | 'cargo' | 'pip' | 'composer';
interface Task {
  label: string;
  file: string;
  cwd: string;
  command: string;
  args: string[];
  audit?: Audit;
}
interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  problem?: string;
}

function run(task: Task, timeout: number, isolated?: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise(resolveRun => {
    const env: NodeJS.ProcessEnv = isolated ?? { CI: 'true', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' };
    if (!isolated) for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA',
      'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'CARGO_HOME', 'RUSTUP_HOME', 'SSL_CERT_FILE']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const child = spawn(task.command, task.args, { cwd: task.cwd, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      env });
    let stdout = '', stderr = '', bytes = 0, problem: string | undefined;
    const stop = (reason: string) => {
      if (problem) return;
      problem = reason;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* Süreç daha önce kapanmış olabilir. */ }
    };
    const timer = setTimeout(() => stop('zaman sınırı aşıldı'), timeout);
    function capture(stream: 'stdout' | 'stderr', chunk: Buffer) {
      if (problem) return;
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) return stop('çıktı sınırı aşıldı');
      if (stream === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    }
    child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk));
    child.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolveRun({ code: null, stdout: '', stderr: '', problem: err.code === 'ENOENT' ? 'araç bulunamadı' : 'süreç başlatılamadı' });
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, problem });
    });
  });
}

async function auditRun(root: string, task: Task, files: readonly SourceFile[], timeout: number): Promise<Run> {
  const temp = await mkdtemp(join(tmpdir(), 'd54-advisory-'));
  try {
    const cwd = join(temp, 'input'), home = join(temp, 'home');
    await mkdir(cwd);
    await mkdir(home);
    try { await prepareAudit(root, task.file, task.audit!, cwd, pathsOf(files)); }
    catch { return { code: null, stdout: '', stderr: '', problem: 'güvenli denetim girdisi üretilemedi. Özel kaynak, desteklenmeyen sürüm, büyük veya eksik kilit dosyası olabilir' }; }
    const search: string[] = [];
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (!isAbsolute(dir)) continue;
      try {
        const actual = await realpath(dir);
        if (actual !== root && !actual.startsWith(root + sep) && !actual.split(sep).includes('node_modules')) search.push(actual);
      } catch { /* Kullanılmayan PATH girdisi. */ }
    }
    const env: NodeJS.ProcessEnv = { PATH: search.join(delimiter), HOME: home, USERPROFILE: home, TMPDIR: temp, TEMP: temp,
      CI: 'true', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
      CARGO_HOME: join(home, '.cargo'), COMPOSER_HOME: join(home, '.composer'), XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
      npm_config_registry: 'https://registry.npmjs.org/', npm_config_ignore_scripts: 'true',
      npm_config_userconfig: join(home, 'user.npmrc'), npm_config_globalconfig: join(home, 'global.npmrc'),
      PYTHONNOUSERSITE: '1', PIP_NO_INPUT: '1', PIP_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null' };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    return await run({ ...task, cwd }, timeout, env);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

function compilerAt(cwd: string, root: string): string | undefined {
  let dir = cwd;
  while (true) {
    const candidate = join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
    if (existsSync(candidate)) return candidate;
    if (dir === root || dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
}

function plan(root: string, files: readonly SourceFile[], notes: string[], audits: boolean, checks: boolean, rustChecks: boolean): Task[] {
  const tasks: Task[] = [];
  const paths = pathsOf(files);
  const pythonRoots = new Set<string>();
  for (const file of files) {
    const name = basename(file.path), dir = dirname(file.path), cwd = resolve(root, dir);
    const add = (label: string, command: string, args: string[], audit?: Audit) =>
      tasks.push({ file: file.path, cwd, label, command, args, audit });
    const sibling = (filename: string) => paths.has(join(dir, filename).split(sep).join('/'));
    if (audits && name === 'package.json') {
      if (sibling('package-lock.json') || sibling('npm-shrinkwrap.json')) {
        add('npm audit', 'npm', ['audit', '--json', '--ignore-scripts', '--fetch-retries=0'], 'npm');
      } else notes.push(file.path + ' için npm kilit dosyası bulunamadı. npm danışmanlık denetimi atlandı.');
    }
    if (checks && name === 'package.json') {
      try {
        if (typeof JSON.parse(file.text)?.scripts?.build === 'string') add('npm build', 'npm', ['run', 'build']);
      } catch { /* Statik tarayıcı JSON hatasını ayrıca işaretler. */ }
    }
    if (checks && name === 'tsconfig.json') {
      const local = compilerAt(cwd, root);
      const args = ['--noEmit', '--pretty', 'false', '--project', name];
      add('TypeScript', local ? process.execPath : 'tsc', local ? [local, ...args] : args);
    }
    if (audits && name === 'Cargo.toml') {
      if (sibling('Cargo.lock')) add('cargo audit', 'cargo-audit', ['audit', '--json', '--file', 'Cargo.lock'], 'cargo');
      else notes.push(file.path + ' için Cargo.lock bulunamadı. Rust danışmanlık denetimi atlandı.');
    }
    if (rustChecks && name === 'Cargo.toml') {
      add('cargo check', 'cargo', ['check', '--locked', '--message-format=json']);
      add('cargo clippy', 'cargo', ['clippy', '--locked', '--message-format=json', '--', '-D', 'warnings']);
      if (checks) add('cargo build', 'cargo', ['build', '--locked', '--message-format=json']);
    }
    if (audits && name === 'composer.json') {
      if (sibling('composer.lock')) add('composer audit', 'composer', ['--no-plugins', '--no-scripts', '--no-interaction', 'audit', '--locked', '--format=json'], 'composer');
      else notes.push(file.path + ' için composer.lock bulunamadı. PHP danışmanlık denetimi atlandı.');
    }
    if (checks && name === 'composer.json') {
      const phpstan = join(cwd, 'vendor', 'bin', 'phpstan');
      add('PHPStan', existsSync(phpstan) ? phpstan : 'phpstan', ['analyse', '--no-progress', '--error-format=raw', '.']);
    }
    if (audits && name === 'requirements.txt') add('pip-audit', 'pip-audit', ['--format', 'json', '--progress-spinner', 'off', '--no-deps', '--disable-pip', '-s', 'pypi', '-r', name], 'pip');
    if (name === 'pyproject.toml' || name === 'mypy.ini' || name === 'requirements.txt') pythonRoots.add(dir);
    if (checks && /\.php$/i.test(name)) add('PHP sözdizimi', 'php', ['-n', '-l', './' + name]);
  }
  if (files.some(file => /\.py$/.test(file.path)) && !pythonRoots.size) pythonRoots.add('.');
  for (const dir of pythonRoots) {
    const prefix = dir === '.' ? '' : dir + '/';
    const source = files.find(file => file.path.startsWith(prefix) && /\.py$/.test(file.path));
    if (!source) continue;
    if (checks) tasks.push({ label: 'mypy', command: 'mypy', args: ['--no-incremental', '--no-error-summary', '.'], file: source.path, cwd: resolve(root, dir) });
    if (audits && !paths.has(prefix + 'requirements.txt')) notes.push((prefix || '.') + ' için requirements.txt bulunamadı. pip-audit atlandı.');
  }
  return tasks;
}

type Bag = Record<string, unknown>;
function bag(value: unknown): Bag | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Bag : undefined;
}

function severity(value: unknown): Issue['severity'] {
  return value === 'critical' || value === 'high' || value === 'low' ? value : 'medium';
}

interface Advisory { id: string; dependency: string; fixed?: string; severity: Issue['severity'] }
function advisories(kind: Audit, data: unknown): Advisory[] | undefined {
  const top = bag(data);
  if (!top || top.error) return undefined;
  const items: Advisory[] = [];
  const record = (value: unknown, level: unknown, name: unknown, fix?: unknown) => {
    const id = String(value ?? '').match(/\b(?:CVE-\d{4}-\d{4,}|GHSA-[2-9cfghjmpqrvwx]{4}-[2-9cfghjmpqrvwx]{4}-[2-9cfghjmpqrvwx]{4}|RUSTSEC-\d{4}-\d+|PYSEC-\d{4}-\d+|PKSA-[a-z0-9-]+)\b/i)?.[0];
    const dependency = typeof name === 'string' && /^@?[a-z0-9][a-z0-9._/-]{0,212}$/i.test(name) ? name : '';
    const fixed = typeof fix === 'string' && /^v?\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.-]{1,40})?$/i.test(fix) ? fix : undefined;
    items.push({ id: id ?? '', dependency, fixed, severity: severity(level) });
  };
  if (kind === 'npm') {
    const packages = bag(top.vulnerabilities);
    if (!packages) return undefined;
    for (const value of Object.values(packages)) {
      const entry = bag(value);
      const via = entry?.via;
      if (!Array.isArray(via)) return undefined;
      const direct = via.map(bag).filter(v => v !== undefined);
      const fix = bag(entry?.fixAvailable);
      const fixed = fix?.name === entry?.name ? fix?.version : undefined;
      if (direct.length) direct.forEach(v => record(v.url, v.severity, entry?.name, fixed));
      else if (via.length) record(undefined, entry?.severity, entry?.name, fixed);
    }
  } else if (kind === 'cargo') {
    const list = bag(top.vulnerabilities)?.list;
    if (!Array.isArray(list)) return undefined;
    list.forEach(item => record(bag(bag(item)?.advisory)?.id, undefined, bag(bag(item)?.package)?.name));
  } else if (kind === 'pip') {
    if (!Array.isArray(top.dependencies)) return undefined;
    for (const item of top.dependencies) {
      const dependency = bag(item);
      if (!Array.isArray(dependency?.vulns)) return undefined;
      dependency.vulns.forEach(v => {
        const fixes = bag(v)?.fix_versions;
        record(bag(v)?.id, undefined, dependency.name, Array.isArray(fixes) ? fixes[0] : undefined);
      });
    }
  } else {
    if (!(bag(top.advisories) || Array.isArray(top.advisories))) return undefined;
    for (const entries of Object.values(top.advisories as Bag)) {
      if (!Array.isArray(entries)) return undefined;
      entries.forEach(v => record(bag(v)?.cve ?? bag(v)?.advisoryId, bag(v)?.severity, bag(v)?.packageName));
    }
  }
  return items;
}

function diagnosticLocations(task: Task, output: string, root: string, paths: ReadonlySet<string>) {
  const results = new Map<string,{file:string,line?:number,code?:string}>();
  function locate(filename: string, line: number, code?: string) {
    const path = relative(root, resolve(task.cwd, filename)).split(sep).join('/');
    if (paths.has(path) && Number.isSafeInteger(line) && line > 0) results.set(JSON.stringify([path,line,code]),{file:path,line,code});
  }
  for (const line of output.split(/\r?\n/)) {
    if (task.label.startsWith('cargo ') && line.startsWith('{')) {
      try {
        const message = JSON.parse(line)?.message;
        const span = message?.spans?.find((v: { is_primary?: boolean }) => v?.is_primary);
        if (message?.level === 'error' && typeof span?.file_name === 'string') {
          const code = message.code?.code;
          locate(span.file_name, span.line_start, typeof code==='string' && /^(?:E\d{4}|clippy::[a-z_]+)$/.test(code) ? code : undefined);
        }
      } catch { /* Derleme çıktısı JSON olmayan satırlar içerebilir. */ }
    }
    const tsc = line.match(/^(.+?)\((\d+),\d+\): error (TS\d+)\b/);
    if (tsc) locate(tsc[1]!, Number(tsc[2]), tsc[3]);
    const mypy = line.match(/^(.+?):(\d+)(?::\d+)?: error:/);
    if (mypy) locate(mypy[1]!, Number(mypy[2]));
    if (task.label === 'PHPStan') {
      const phpstan = line.match(/^(.+?):(\d+):/);
      if (phpstan) locate(phpstan[1], Number(phpstan[2]));
    }
    if (task.label === 'PHP sözdizimi') {
      const php = line.match(/ on line (\d+)\s*$/);
      if (php) locate(basename(task.file), Number(php[1]));
    }
  }
  return results.size ? [...results.values()] : [{ file: task.file, line: undefined, code: undefined }];
}

export async function scanTools(root: string, files: readonly SourceFile[], trusted: boolean, modules: readonly Category[] = categories): Promise<{ issues: Issue[]; notes: string[] }> {
  const notes: string[] = [], issues: Issue[] = [];
  root = resolve(root);
  const audits = modules.includes('security'), checks = modules.includes('errors');
  const rustOnly = modules.includes('specialized') && !checks && files.some(f=>basename(f.path)==='Cargo.toml');
  if (rustOnly && !trusted) notes.push('Cargo check ve clippy için güvenilir yerel proje izni gerekir.');
  if (checks && !trusted) notes.push('Proje komutları için güvenilir çalışma izni verilmedi. Tip, lint ve derleme araçları atlandı.');
  if (!audits && !((checks || rustOnly) && trusted)) return { issues, notes };
  const planned = plan(root, files, notes, audits, checks && trusted, (checks || rustOnly) && trusted);
  const tasks = [...planned.filter(t => t.audit), ...planned.filter(t => !t.audit)];
  if (tasks.some(t => t.audit)) notes.push('Bağımlılık denetimi geçici dizinlerde çalışır. Paket adları ve sabit sürümler genel danışmanlık hizmetlerinde sorgulanabilir.');
  const deadline = Date.now() + 5 * 60_000;
  let completed = 0;
  for (const task of tasks) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || completed >= 120) {
      notes.push(String(tasks.length - completed) + ' araç görevi toplam süre veya işlem sınırı nedeniyle atlandı.');
      break;
    }
    completed++;
    const timeout = Math.min(remaining, 45_000);
    let result: Run;
    try { result = task.audit ? await auditRun(root, task, files, timeout) : await run(task, timeout); }
    catch { notes.push(task.file + ' — ' + task.label + ' çalışma ortamı hazırlanamadı veya temizlenemedi.'); continue; }
    const label = task.file + ' — ' + task.label;
    if (result.problem) { notes.push(label + ' tamamlanamadı (' + result.problem + ').'); continue; }
    if (task.audit) {
      let rows: Advisory[] | undefined;
      try { rows = advisories(task.audit, JSON.parse(result.stdout)); }
      catch { /* Bozuk veya eksik sonuç temiz sayılmaz. */ }
      if (!rows || result.code === null || (result.code !== 0 && !rows.length)) {
        notes.push(label + ' geçerli danışmanlık sonucu vermedi. Araç kurulumu, kilit dosyası ve ağ erişimini kontrol edin.');
        continue;
      }
      const counts = new Map<string, { count: number; row: Advisory }>();
      for (const row of rows) {
        const key = JSON.stringify([row.severity, row.dependency, row.id]);
        const group = counts.get(key);
        if (group) group.count++;
        else counts.set(key, { count: 1, row });
      }
      for (const { count, row } of counts.values()) issues.push({ file: task.file, rule: 'security.advisory-' + task.audit,
        category: 'security', severity: row.severity, title: ['Bağımlılık uyarısı', row.dependency, row.id].filter(Boolean).join(' '),
        evidence: task.label + ' çıktısında ' + count + ' eşleşme bulundu.' + (row.id ? ' Kimlik ' + row.id + '.' : ''),
        impact: 'Kullanılan bir bağımlılık bilinen güvenlik açığıyla ilişkilendirildi.',
        advice: row.fixed ? 'Araç düzeltilmiş sürüm olarak ' + row.fixed + ' bildirdi. Uyumluluğu doğrulayıp bağımlılığı güncelleyin.'
          : 'Araç çıktısındaki bağımlılık yolunu inceleyip düzeltilmiş sürüme güncelleyin.' });
      notes.push(label + ' tamamlandı. Bildirilen eşleşme sayısı ' + rows.length + '.');
    } else if (result.code === 0) {
      notes.push(label + ' başarılı.');
    } else {
      const locations = diagnosticLocations(task, result.stdout + '\n' + result.stderr, root, pathsOf(files));
      if (/no such command|command not found|not recognized as an internal|no module named/i.test(result.stderr + result.stdout)
          && locations[0].line === undefined) { notes.push(label + ' için gereken komut veya modül bulunamadı.'); continue; }
      if (result.code === null) { notes.push(label + ' bir sinyal ile sonlandı.'); continue; }
      for (const location of locations.slice(0,100)) issues.push({ file: location.file, line: location.line, category: rustOnly ? 'specialized' : 'errors', rule: rustOnly ? 'specialized.tool-failure' : 'errors.tool-failure',
        severity: 'high', title: task.label + ' başarısız', evidence: 'Çıkış kodu ' + result.code + '.' + (location.code ? ' Tanı ' + location.code + '.' : ''),
        impact: 'Proje bu ortamda ilgili doğrulama adımını geçemedi.', advice: 'Aracı aynı proje dizininde çalıştırıp ilk tanıyı ve kurulu bağımlılıkları kontrol edin.' });
      notes.push(label + ' hata bildirdi.');
    }
  }
  if (!tasks.length && !notes.length) notes.push('Desteklenen bir harici araç hedefi bulunamadı.');
  return { issues, notes };
}
