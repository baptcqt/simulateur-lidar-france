import * as THREE from 'three';
import { spawn, Thread, Transfer } from 'threads';

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
  const parsedData = await decoder.parseChunk(Transfer(data), {
    pointCount: options.in?.pointCount,
    header: options.in?.header,
    eb: options.in?.eb,
    colorDepth: options.in?.colorDepth,
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
