import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const resources = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);
const port = Number(process.env.PORT ?? 4173);
createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const entry = resources.get(request.url.split('?')[0]);
  if (!entry) {
    response.writeHead(404).end();
    return;
  }
  try {
    const data = await readFile(new URL(entry[0], import.meta.url));
    response.writeHead(200, {
      'Content-Type': entry[1],
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      'X-Content-Type-Options': 'nosniff'
    }).end(request.method === 'HEAD' ? undefined : data);
  } catch {
    response.writeHead(500).end();
  }
}).listen(port, '127.0.0.1', function () {
  console.log('D54 örneği http://127.0.0.1:' + this.address().port);
});
