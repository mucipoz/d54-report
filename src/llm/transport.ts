export interface Connection { base: string; model: string; key: string }

export async function post(base: string, path: string, headers: Record<string,string>, payload: unknown): Promise<unknown> {
  const url = new URL(base.replace(/\/+$/, '') + path);
  if (url.username || url.password || url.hash || url.search ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)))) {
    throw Error('Model adresi HTTPS veya yerel HTTP olmalıdır.');
  }
  const response = await fetch(url, { method: 'POST', headers: {'Content-Type':'application/json', ...headers},
    body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw Error('Model HTTP ' + response.status); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  while (true) {
    const {value,done} = await reader.read();
    if (done) break;
    n += value.length;
    if (n > 512_000) { await reader.cancel(); throw Error('Model yanıt sınırını aştı.'); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
