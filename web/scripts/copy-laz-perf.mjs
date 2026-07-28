import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(scriptDirectory, '..');
const source = path.join(webDirectory, 'node_modules', 'laz-perf', 'lib', 'laz-perf.wasm');
const targetDirectory = path.join(webDirectory, 'public', 'laz-perf');
const target = path.join(targetDirectory, 'laz-perf.wasm');

await mkdir(targetDirectory, { recursive: true });
await copyFile(source, target);
console.log(`Décodeur LAZ copié vers ${target}`);
