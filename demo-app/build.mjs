import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./', import.meta.url));
const output = join(root, 'dist');
await mkdir(output, { recursive: true });
for (const name of ['index.html', 'app.js', 'styles.css']) {
  await copyFile(join(root, name), join(output, name));
}
