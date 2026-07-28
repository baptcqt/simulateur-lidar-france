import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(scriptDirectory, '..');
const require = createRequire(import.meta.url);

async function findPackage(name) {
  const entry = require.resolve(name);
  let directory = path.dirname(entry);
  const root = path.parse(directory).root;

  while (directory !== root) {
    const candidate = path.join(directory, 'package.json');
    if (existsSync(candidate)) {
      const metadata = JSON.parse(await readFile(candidate, 'utf8'));
      if (metadata.name === name) return { entry, directory, root: directory, metadata };
    }
    directory = path.dirname(directory);
  }
  throw new Error(`package.json introuvable pour ${name}`);
}

function assertVersion(packageInfo, expected) {
  if (packageInfo.metadata.version !== expected) {
    throw new Error(`${packageInfo.metadata.name} ${packageInfo.metadata.version} installé, version ${expected} attendue`);
  }
}

async function assertWasm(file) {
  const info = await stat(file);
  if (info.size < 8) throw new Error(`Fichier WebAssembly vide ou tronqué : ${file}`);
  const bytes = await readFile(file);
  if (bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error(`Signature WebAssembly invalide : ${file}`);
  }
}

const packages = {
  itowns: await findPackage('itowns'),
  three: await findPackage('three'),
  proj4: await findPackage('proj4'),
  lazPerf: await findPackage('laz-perf'),
};

assertVersion(packages.itowns, '2.46.0');
assertVersion(packages.three, '0.174.0');
assertVersion(packages.proj4, '2.19.3');
assertVersion(packages.lazPerf, '0.0.6');

const itownsRequire = createRequire(packages.itowns.entry);
itownsRequire.resolve('copc');
itownsRequire.resolve('threads');

const lasWorker = path.join(packages.itowns.root, 'lib', 'Worker', 'LASLoaderWorker.js');
if (!existsSync(lasWorker)) throw new Error(`Worker LAS iTowns introuvable : ${lasWorker}`);

const workerSource = await readFile(lasWorker, 'utf8');
if (!workerSource.includes('expose(')) {
  throw new Error(`Le worker LAS iTowns ne publie pas son API threads : ${lasWorker}`);
}

const viteConfigPath = path.join(webDirectory, 'vite.config.mjs');
const viteConfig = (await import(`${pathToFileURL(viteConfigPath).href}?audit=${Date.now()}`)).default;
if (!viteConfig.optimizeDeps?.exclude?.includes('itowns')) {
  throw new Error("Vite doit exclure 'itowns' de optimizeDeps pour préserver l'URL relative du worker LAS");
}
if (viteConfig.worker?.format !== 'es') {
  throw new Error("Le format des workers Vite doit être 'es'");
}

const sourceWasm = path.join(packages.lazPerf.root, 'lib', 'laz-perf.wasm');
const publicWasm = path.join(webDirectory, 'public', 'laz-perf', 'laz-perf.wasm');
await assertWasm(sourceWasm);
await assertWasm(publicWasm);

console.log('Chaîne COPC iTowns vérifiée :');
console.log(`- iTowns ${packages.itowns.metadata.version}`);
console.log(`- Three.js ${packages.three.metadata.version}`);
console.log(`- proj4 ${packages.proj4.metadata.version}`);
console.log(`- laz-perf ${packages.lazPerf.metadata.version}`);
console.log('- worker LAS iTowns présent et expose() détecté');
console.log('- iTowns exclu de l’optimiseur Vite pour préserver son worker');
console.log('- workers Vite générés au format ES module');
console.log('- WebAssembly laz-perf valide et servi localement');
