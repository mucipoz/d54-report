import type { Route } from 'playwright';

const perResponse = 8 * 1024 * 1024;
const perViewport = 64 * 1024 * 1024;

/** Handle every HTTP hop outside Chromium so a redirect cannot bypass origin checks. */
export function passiveRequests(origin: string) {
  let requests = 0, bytes = 0;
  const counters = { blocked: 0, redirects: 0 };
  function allowed(url: URL) {
    return url.origin === origin && !url.username && !url.password && ['http:', 'https:'].includes(url.protocol);
  }
  async function routeRequest(route: Route, onDocumentRedirect?: (to: string) => void) {
    const request = route.request();
    try {
      let url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method()) || !allowed(url)) throw Error();
      const requestHeaders = await request.allHeaders();
      for (const key of Object.keys(requestHeaders)) {
        if (key.startsWith(':') || ['connection', 'host', 'content-length', 'transfer-encoding'].includes(key)) delete requestHeaders[key];
      }
      requestHeaders['accept-encoding'] = 'identity';
      for (let hop = 0; hop <= 5; hop++) {
        if (++requests > 256 || bytes >= perViewport) throw Error();
        const response = await fetch(url, { method: request.method(), headers: requestHeaders,
          redirect: 'manual', signal: AbortSignal.timeout(12_000) });
        if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.has('location')) {
          await response.body?.cancel();
          url = new URL(response.headers.get('location')!, url);
          if (!allowed(url)) throw Error();
          counters.redirects++;
          if (onDocumentRedirect) {
            onDocumentRedirect(url.href);
            return await route.fulfill({ status: 200, contentType: 'text/html', body: '' });
          }
          continue;
        }
        const chunks: Uint8Array[] = [];
        const reader = response.body?.getReader();
        let size = 0;
        if (reader) {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              bytes += value.byteLength;
              if (size > perResponse || bytes > perViewport) throw Error();
              chunks.push(value);
            }
          } finally { await reader.cancel().catch(() => {}); }
        }
        const headers = Object.fromEntries(response.headers);
        // Fetch returns decoded bytes. Chromium must not decode them again.
        for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'location']) delete headers[name];
        return await route.fulfill({ status: response.status, headers, body: Buffer.concat(chunks, size) });
      }
      throw Error();
    } catch {
      counters.blocked++;
      await route.abort('blockedbyclient').catch(() => {});
    }
  }
  return { routeRequest, counters };
}
