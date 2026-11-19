import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { scanUI } from '../src/scanners/ui-design.js';

it('rejects local-file targets before launching a browser', async () => {
  await expect(scanUI('file:///tmp/example.html', '.')).rejects.toThrow('HTTP(S)');
});

const browserAvailable = existsSync(process.env.D54_CHROMIUM_PATH || chromium.executablePath());
it.skipIf(!browserAvailable)('measures real viewports, captures regions and blocks writes', async () => {
  const output = await mkdtemp(join(tmpdir(), 'd54-ui-'));
  let writes = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST') writes++;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body { margin: 24px; background: white; }
        nav { display: flex; }
        a { display: block; width: 120px; height: 50px; background: white; }
        a + a { margin-left: -80px; }
        p { white-space: nowrap; overflow: hidden; width: 24px; color: #aaa; }
        h1 { min-width: 450px; }
      </style>
      <nav><a href="#a">First control</a><a href="#b">Second control</a></nav>
      <p>Long clipped label</p><h1>Heading</h1>
      <svg width="30" height="30"><use href="#missing"></use></svg>
      <script>console.error('PRIVATE_TEST_MARKER');fetch('/write',{method:'POST'}).catch(()=>{});</script>`);
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server is unavailable');
    const url = 'http://127.0.0.1:' + address.port + '/?label=PRIVATE_TEST_MARKER';
    const { issues, notes } = await scanUI(url, output);
    expect(writes).toBe(0);
    expect(JSON.stringify({ issues, notes })).not.toContain('PRIVATE_TEST_MARKER');
    for (const rule of ['ui.overlap', 'ui.clipped', 'ui.contrast', 'ui.obscured', 'ui.icon', 'ui.overflow', 'errors.browser-consoleErrors', 'security.missing-csp']) {
      expect(issues.some(issue => issue.rule === rule), rule + ' / ' + notes.join(', ')).toBe(true);
    }
    expect(new Set(issues.filter(i => i.rule === 'ui.overlap').map(i => i.viewport)).size).toBe(3);
    expect(issues.filter(i => i.rule === 'ui.overflow').every(i => i.viewport?.startsWith('mobile'))).toBe(true);
    for (const finding of issues.filter(i => i.category === 'ui')) {
      expect(finding.selector).toBeTruthy();
      expect(finding.screenshot).toMatch(/^screenshots\/.+\.png$/);
      const bytes = await readFile(join(output, finding.screenshot!));
      expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    }
    expect(notes.filter(note => note.includes('TTFB'))).toHaveLength(3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(output, { recursive: true, force: true });
  }
});
