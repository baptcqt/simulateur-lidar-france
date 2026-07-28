import * as THREE from 'three';
import * as itowns from 'itowns';

type PatchedView = {
  referenceCrs: string;
  camera?: { crs?: string };
  camera3D: THREE.PerspectiveCamera;
  notifyChange: (target?: unknown) => void;
};

type CopcLayerLike = {
  isCopcLayer?: boolean;
  source?: { crs?: string; whenReady?: Promise<unknown> };
  root?: {
    voxelOBB?: {
      box3D: THREE.Box3;
      localToWorld: (point: THREE.Vector3) => THREE.Vector3;
    };
  };
  group?: THREE.Group & { traverse: (callback: (object: THREE.Object3D) => void) => void };
  addEventListener?: (type: string, listener: (event: any) => void) => void;
};

const PATCH_FLAG = Symbol.for('simulateur-lidar-france.itowns-copc-runtime');
const viewPrototype = itowns.View.prototype as any;

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function zoomToCopcLayer(view: PatchedView, layer: CopcLayerLike): void {
  const obb = layer.root?.voxelOBB;
  if (!obb) return;

  // Cadrage identique à examples/jsm/PointCloudHelper.js dans iTowns.
  const center = obb.box3D.getCenter(new THREE.Vector3());
  obb.localToWorld(center);
  const length = obb.box3D.getSize(new THREE.Vector3()).length();
  const camera = view.camera3D;
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const distance = Math.max(length / 2, 1) / Math.tan(fov / 2);

  camera.position.copy(center).addScaledVector(new THREE.Vector3(0, 0, 1), distance);
  camera.up.copy(new THREE.Vector3(0, 1, 0));
  camera.near = Math.max(distance / 100_000, 0.1);
  camera.far = Math.max(2 * distance, 1_000);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  view.notifyChange(camera);
}

function makeCopcErrorsObservable(layer: CopcLayerLike): void {
  if (!layer.group || !layer.addEventListener) return;

  let loadError: Error | null = null;
  const originalTraverse = layer.group.traverse.bind(layer.group);
  layer.group.traverse = (callback: (object: THREE.Object3D) => void): void => {
    if (loadError) throw loadError;
    originalTraverse(callback);
  };

  layer.addEventListener('load-error', (event: any) => {
    if (event?.error?.isCancelledCommandException) return;
    loadError = new Error(`iTowns n’a pas pu décoder un bloc LAZ : ${errorMessage(event?.error)}`);
    window.dispatchEvent(new CustomEvent('itowns-copc-error', { detail: loadError.message }));
  });
}

if (!viewPrototype[PATCH_FLAG]) {
  const originalAddLayer = viewPrototype.addLayer;

  viewPrototype.addLayer = async function patchedAddLayer(layer: CopcLayerLike, ...args: unknown[]) {
    if (layer?.isCopcLayer && layer.source?.whenReady) {
      await layer.source.whenReady;
      if (layer.source.crs) {
        this.referenceCrs = layer.source.crs;
        if (this.camera) this.camera.crs = layer.source.crs;
      }
      makeCopcErrorsObservable(layer);
    }

    const result = await originalAddLayer.call(this, layer, ...args);

    if (layer?.isCopcLayer) {
      // Les chargeurs existants font encore leur propre cadrage juste après
      // addLayer. Le requestAnimationFrame garantit que le cadrage officiel
      // iTowns est appliqué en dernier, lorsque le conteneur est visible.
      window.requestAnimationFrame(() => zoomToCopcLayer(this as PatchedView, layer));
    }

    return result;
  };

  viewPrototype[PATCH_FLAG] = true;
}

window.addEventListener('itowns-copc-error', (event) => {
  const message = (event as CustomEvent<string>).detail;
  console.error('[iTowns COPC]', message);
});
