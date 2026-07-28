import { expose, Transfer } from 'threads/worker';
import LASLoader from '@itowns-las-loader';
import proj4 from 'proj4';

// Le worker officiel iTowns 2.46 décompresse correctement les blocs LAZ, mais
// cette version ne reprojette pas encore les positions vers le CRS de la vue.
// On conserve son LASLoader et on applique ici le même principe que le pipeline
// iTowns récent : coordonnées source absolues -> CRS de la vue -> repère local.
const loader = new LASLoader();

function transferable(attributes) {
  return Object.values(attributes)
    .filter(ArrayBuffer.isView)
    .map((attribute) => attribute.buffer);
}

function registerProjection(code, definition) {
  if (!code || !definition) return;
  proj4.defs(code, definition);
}

function projectAttributes(result, options) {
  const attributes = result.attributes;
  const sourceCrs = options.sourceCrs;
  const targetCrs = options.targetCrs;

  if (!sourceCrs || !targetCrs || sourceCrs === targetCrs) return result;
  if (!attributes?.position || !Array.isArray(attributes.origin)) return result;

  registerProjection(sourceCrs, options.sourceDefinition);
  registerProjection(targetCrs, options.targetDefinition);

  const converter = proj4(sourceCrs, targetCrs);
  const sourceOrigin = attributes.origin;
  const targetOrigin = converter.forward([
    sourceOrigin[0],
    sourceOrigin[1],
    sourceOrigin[2],
  ]);

  const sourcePositions = attributes.position;
  const targetPositions = new Float32Array(sourcePositions.length);

  for (let index = 0; index < sourcePositions.length; index += 3) {
    const projected = converter.forward([
      sourceOrigin[0] + sourcePositions[index],
      sourceOrigin[1] + sourcePositions[index + 1],
      sourceOrigin[2] + sourcePositions[index + 2],
    ]);

    targetPositions[index] = projected[0] - targetOrigin[0];
    targetPositions[index + 1] = projected[1] - targetOrigin[1];
    targetPositions[index + 2] = projected[2] - targetOrigin[2];
  }

  attributes.position = targetPositions;
  attributes.origin = targetOrigin;
  return result;
}

expose({
  lazPerf(path) {
    loader.lazPerf = path;
  },

  async parseChunk(data, options) {
    const result = await loader.parseChunk(data, options);
    projectAttributes(result, options);
    return Transfer(result, transferable(result.attributes));
  },
});
