import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, extname } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostToolPath, readBoundedFile } from './fs-guards.js';

export function githubRepoUrl(address: string): string {
  const u = new URL(address);
  if (u.origin !== 'https://github.com' || u.username || u.password || u.search || u.hash ||
      !/^\/[A-Za-z\d_.-]+\/[A-Za-z\d_.-]+\/?$/.test(u.pathname)) throw Error('Tam bir HTTPS GitHub depo URL’si gerekli.');
  return u.href;
}
export async function checkout(address: string) {
  const url = githubRepoUrl(address);
  const dir = await mkdtemp(join(tmpdir(), 'd54-clone-'));
  const root = join(dir, 'source');
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    await promisify(execFile)('git', ['-c','core.hooksPath=/dev/null','-c','protocol.allow=never','-c','protocol.https.allow=always',
      '-c','http.followRedirects=false','clone','--template=','--no-recurse-submodules','--depth=1','--single-branch','--no-tags','--',url,root], {
      cwd: dir, timeout: 90_000, maxBuffer: 1024 * 1024,
      env: { PATH: hostToolPath(process.cwd(),'git'), HOME: dir, GIT_CEILING_DIRECTORIES: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
    });
    return { root, cleanup };
  } catch { await cleanup(); throw Error('GitHub deposu salt okunur HTTPS ile klonlanamadı. Özel depo için yerel checkout ve --path kullanın.'); }
}

const mime: Record<string,string> = {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ico':'image/x-icon','.webp':'image/webp','.json':'application/json'};
const privatePart = /(?:^\.|^(?:node_modules|vendor|reports|backend|server|scripts|tests?|coverage|config|private|secrets?|credentials?)$|(?:^|[._-])(?:config|secrets?|credentials?|private[-_]?keys?|service[-_]?accounts?|server)(?:[._-]|$))/i;

export async function previewAsset(root: string, pathname: string, excluded?: string) {
  if (!pathname.startsWith('/') || /[\\\x00-\x1f]/.test(pathname)) throw Error();
  const parts = pathname.split('/').filter(Boolean);
  if (pathname.endsWith('/')) parts.push('index.html');
  if (parts.some(part => privatePart.test(part))) throw Error();
  const path = resolve(root, ...parts);
  const type = mime[extname(path)];
  if (!type || (type === 'application/json' && !['assets', 'public', 'static'].includes(parts[0] ?? ''))
      || (excluded && (path === excluded || path.startsWith(excluded + sep)))) throw Error();
  const info = await lstat(path);
  if (!path.startsWith(root + sep) || !info.isFile() || info.size > 8_388_608 || await realpath(path) !== path) throw Error();
  return { path, type };
}

export async function preview(root: string, excluded?: string) {
  root = await realpath(root);
  const server = createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method ?? '') || req.headers.host !== '127.0.0.1:' + (server.address() as AddressInfo).port) throw Error();
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      const { path, type } = await previewAsset(root, pathname, excluded);
      const content = req.method === 'HEAD' ? undefined : await readBoundedFile(path, 8_388_608);
      res.writeHead(200, {'Content-Type':type,'X-Content-Type-Options':'nosniff'});
      res.end(content);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((ok,fail) => { server.once('error',fail); server.listen(0,'127.0.0.1',ok); });
  return { url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    close: async () => { server.closeAllConnections(); await new Promise<void>((ok,fail) => server.close(e => e ? fail(e) : ok())); } };
}
