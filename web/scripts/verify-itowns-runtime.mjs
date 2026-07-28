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
  copc: await findPackage('copc'),
  threads: await findPackage('threads'),
};

assertVersion(packages.itowns, '2.46.0');
assertVersion(packages.three, '0.174.0');
assertVersion(packages.proj4, '2.19.3');
assertVersion(packages.lazPerf, '0.0.6');
assertVersion(packages.copc, '0.0.8');
assertVersion(packages.threads, '1.7.0');

const lasLoader = path.join(packages.itowns.root, 'lib', 'Loader', 'LASLoader.js');
if (!existsSync(lasLoader)) throw new Error(`LASLoader iTowns introuvable : ${lasLoader}`);

const localWorker = path.join(webDirectory, 'src', 'las-decoder.worker.js');
const localParser = path.join(webDirectory, 'src', 'local-las-parser.ts');
const bootstrap = path.join(webDirectory, 'src', 'lidar-bootstrap.ts');
for (const file of [localWorker, localParser, bootstrap]) {
  if (!existsSync(file)) throw new Error(`Composant du worker LiDAR local introuvable : ${file}`);
}

const workerSource = await readFile(localWorker, 'utf8');
if (!workerSource.includes('expose(') || !workerSource.includes("@itowns-las-loader")) {
  throw new Error('Le worker LiDAR local doit exposer son API et utiliser le LASLoader iTowns');
}

const bootstrapSource = await readFile(bootstrap, 'utf8');
if (!bootstrapSource.includes('parseLocalLasChunk') || !bootstrapSource.includes('LASParser')) {
  throw new Error('La page LiDAR ne remplace pas le parseur de chunks par le worker local');
}

const viteConfigPath = path.join(webDirectory, 'vite.config.mjs');
const viteConfig = (await import(`${pathToFileURL(viteConfigPath).href}?audit=${Date.now()}`)).default;
if (viteConfig.optimizeDeps?.exclude?.includes('itowns')) {
  throw new Error("iTowns ne doit pas être exclu de optimizeDeps : cela provoque une page blanche en développement");
}
if (!viteConfig.resolve?.alias?.['@itowns-las-loader']) {
  throw new Error("L'alias Vite @itowns-las-loader est absent");
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
console.log(`- copc ${packages.copc.metadata.version}`);
console.log(`- threads ${packages.threads.metadata.version}`);
console.log('- iTowns précompilé normalement par Vite');
console.log('- worker LAZ local exposé et bundlé par Vite');
console.log('- LASLoader officiel iTowns utilisé dans le worker local');
console.log('- workers Vite générés au format ES module');
console.log('- WebAssembly laz-perf valide et servi localement');
