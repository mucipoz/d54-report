import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, realpath, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, extname } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function checkout(address: string) {
  const u = new URL(address);
  if (u.origin !== 'https://github.com' || u.username || u.password || u.search || u.hash ||
      !/^\/[A-Za-z\d_.-]+\/[A-Za-z\d_.-]+\/?$/.test(u.pathname)) throw Error('Tam bir HTTPS GitHub depo URL’si gerekli.');
  const dir = await mkdtemp(join(tmpdir(), 'd54-clone-'));
  const root = join(dir, 'source');
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    await promisify(execFile)('git', ['-c','core.hooksPath=/dev/null','-c','protocol.allow=never','-c','protocol.https.allow=always','clone','--depth=1','--single-branch','--no-tags','--',u.href,root], {
      timeout: 90_000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
    });
    return { root, cleanup };
  } catch { await cleanup(); throw Error('GitHub deposu salt okunur HTTPS ile klonlanamadı. Özel depo için yerel checkout ve --path kullanın.'); }
}

const mime: Record<string,string> = {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ico':'image/x-icon','.webp':'image/webp','.json':'application/json'};
export async function preview(root: string) {
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      const target = await realpath(resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname)));
      const type = mime[extname(target)];
      if (!['GET', 'HEAD'].includes(req.method ?? '') || !target.startsWith(root + sep) || target.slice(root.length + 1).split(sep).some(x => x.startsWith('.')) || !type || (await stat(target)).size > 8_388_608) throw Error();
      res.writeHead(200, {'Content-Type':type,'X-Content-Type-Options':'nosniff'});
      res.end(req.method === 'HEAD' ? undefined : await readFile(target));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((ok,fail) => { server.once('error',fail); server.listen(0,'127.0.0.1',ok); });
  return { url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    close: async () => { server.closeAllConnections(); await new Promise<void>((ok,fail) => server.close(e => e ? fail(e) : ok())); } };
}
