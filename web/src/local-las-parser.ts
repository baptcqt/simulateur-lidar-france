import * as THREE from 'three';
import proj4 from 'proj4';
import { spawn, Thread, Transfer } from 'threads';

const PROJECTION_DEFINITIONS: Record<string, string> = {
  'EPSG:2154': '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
  'EPSG:4326': '+proj=longlat +datum=WGS84 +no_defs +type=crs',
  'EPSG:4978': '+proj=geocent +datum=WGS84 +units=m +no_defs +type=crs',
};

type DecodedAttributes = {
  position: Float32Array;
  intensity: Uint16Array;
  returnNumber: Uint8Array;
  numberOfReturns: Uint8Array;
  classification: Uint8Array;
  pointSourceID: Uint16Array;
  color?: Uint8Array;
  scanAngle: Float32Array;
  origin: number[];
};

type DecoderThread = {
  lazPerf(path: string): Promise<void>;
  parseChunk(data: unknown, options: unknown): Promise<{ attributes: DecodedAttributes }>;
};

let decoderPromise: Promise<DecoderThread> | undefined;
let decoderThread: DecoderThread | undefined;

function workerInstance(): Worker {
  return new Worker(new URL('./las-decoder.worker.js', import.meta.url), {
    type: 'module',
    name: 'simulateur-lidar-las-decoder',
  });
}

async function getDecoder(): Promise<DecoderThread> {
  if (!decoderPromise) {
    decoderPromise = (async () => {
      const thread = await spawn(workerInstance()) as unknown as DecoderThread;
      await thread.lazPerf('/laz-perf');
      decoderThread = thread;
      return thread;
    })();
  }
  return decoderPromise;
}

function projectionDefinition(crs?: string): string | Record<string, unknown> | undefined {
  if (!crs) return undefined;
  if (PROJECTION_DEFINITIONS[crs]) return PROJECTION_DEFINITIONS[crs];

  const definition = proj4.defs(crs);
  if (!definition) return undefined;
  return JSON.parse(JSON.stringify(definition)) as Record<string, unknown>;
}

function buildBufferGeometry(attributes: DecodedAttributes): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(attributes.position, 3));
  geometry.setAttribute('intensity', new THREE.BufferAttribute(attributes.intensity, 1));
  geometry.setAttribute('returnNumber', new THREE.BufferAttribute(attributes.returnNumber, 1));
  geometry.setAttribute('numberOfReturns', new THREE.BufferAttribute(attributes.numberOfReturns, 1));
  geometry.setAttribute('classification', new THREE.BufferAttribute(attributes.classification, 1));
  geometry.setAttribute('pointSourceID', new THREE.BufferAttribute(attributes.pointSourceID, 1));
  geometry.setAttribute('scanAngle', new THREE.BufferAttribute(attributes.scanAngle, 1));

  if (attributes.color) {
    geometry.setAttribute('color', new THREE.BufferAttribute(attributes.color, 4, true));
  }

  geometry.userData.origin = new THREE.Vector3().fromArray(attributes.origin);
  geometry.computeBoundingBox();
  return geometry;
}

export async function parseLocalLasChunk(data: ArrayBuffer, options: any = {}): Promise<THREE.BufferGeometry> {
  const decoder = await getDecoder();
  const sourceCrs = options.in?.crs as string | undefined;
  const targetCrs = options.out?.crs as string | undefined;

  const parsedData = await decoder.parseChunk(Transfer(data), {
    pointCount: options.in?.pointCount,
    header: options.in?.header,
    eb: options.in?.eb,
    colorDepth: options.in?.colorDepth,
    sourceCrs,
    targetCrs,
    sourceDefinition: projectionDefinition(sourceCrs),
    targetDefinition: projectionDefinition(targetCrs),
  });
  return buildBufferGeometry(parsedData.attributes);
}

export async function terminateLocalLasWorker(): Promise<void> {
  const current = decoderThread;
  decoderThread = undefined;
  decoderPromise = undefined;
  if (current) {
    await Thread.terminate(current as never);
  }
}
