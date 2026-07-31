type RuntimeState = {
  view?: any;
  layers: Map<string, any>;
};

declare global {
  interface Window {
    __SIM_ITOWNS__?: RuntimeState;
  }
}

type Point = { x: number; y: number };
type ZoomController = {
  zoomBy: (factor: number) => void;
};

const installedViews = new WeakSet<object>();
const MIN_RANGE = 3;
const MAX_RANGE = 20_000_000;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function wheelPixels(event: WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * window.innerHeight;
  return event.deltaY;
}

function currentRange(view: any): number {
  const value = Number(view.controls?.getRange?.());
  return Number.isFinite(value) && value > 0 ? value : 2_500;
}

function cameraOptions(view: any, range: number): Record<string, unknown> {
  const controls = view.controls;
  const options: Record<string, unknown> = { range, time: 0 };
  const coord = controls?.getLookAtCoordinate?.();
  const tilt = Number(controls?.getTilt?.());
  const heading = Number(controls?.getHeading?.());
  if (coord) options.coord = coord;
  if (Number.isFinite(tilt)) options.tilt = tilt;
  if (Number.isFinite(heading)) options.heading = heading;
  return options;
}

function createZoomController(view: any): ZoomController {
  let requestedRange: number | null = null;
  let frameRequest = 0;

  const apply = (): void => {
    frameRequest = 0;
    const range = requestedRange;
    requestedRange = null;
    if (range == null || !view.controls?.lookAtCoordinate) return;

    void Promise.resolve(view.controls.lookAtCoordinate(cameraOptions(view, range), false))
      .then(() => view.notifyChange(view.camera3D))
      .catch((error: unknown) => console.warn('[Zoom iTowns]', error));
  };

  return {
    zoomBy(factor: number): void {
      const base = requestedRange ?? currentRange(view);
      requestedRange = clamp(base * factor, MIN_RANGE, MAX_RANGE);
      if (!frameRequest) frameRequest = window.requestAnimationFrame(apply);
    },
  };
}

function addZoomButtons(host: HTMLElement, controller: ZoomController, standalone: boolean): void {
  if (document.querySelector('#simu-reliable-zoom')) return;

  const controls = document.createElement('div');
  controls.id = 'simu-reliable-zoom';
  controls.setAttribute('aria-label', 'Contrôles de zoom');
  if (standalone) controls.classList.add('standalone');

  const zoomIn = document.createElement('button');
  zoomIn.type = 'button';
  zoomIn.textContent = '+';
  zoomIn.title = 'Zoomer';
  zoomIn.setAttribute('aria-label', 'Zoomer');

  const zoomOut = document.createElement('button');
  zoomOut.type = 'button';
  zoomOut.textContent = '−';
  zoomOut.title = 'Dézoomer';
  zoomOut.setAttribute('aria-label', 'Dézoomer');

  for (const button of [zoomIn, zoomOut]) {
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
  }
  zoomIn.addEventListener('click', () => controller.zoomBy(0.68));
  zoomOut.addEventListener('click', () => controller.zoomBy(1.48));
  controls.append(zoomIn, zoomOut);
  host.appendChild(controls);
}

function installInteractionStyles(): void {
  if (document.querySelector('#simu-navigation-styles')) return;
  const style = document.createElement('style');
  style.id = 'simu-navigation-styles';
  style.textContent = `
    html, body, #viewer, #map-surface, #lidar-viewer {
      overscroll-behavior: none;
      overscroll-behavior-x: none;
    }
    #map-surface, #lidar-viewer, #map-surface canvas, #lidar-viewer canvas {
      touch-action: none;
    }
    #simu-reliable-zoom {
      position: absolute;
      right: 16px;
      bottom: 18px;
      z-index: 45;
      display: grid;
      overflow: hidden;
      border: 1px solid rgb(0 0 0 / 22%);
      border-radius: 9px;
      background: rgb(255 255 255 / 96%);
      box-shadow: 0 5px 18px rgb(0 0 0 / 24%);
    }
    #simu-reliable-zoom.standalone { right: 70px; }
    #simu-reliable-zoom button {
      width: 42px;
      height: 42px;
      margin: 0;
      padding: 0;
      border: 0;
      border-bottom: 1px solid #d4dbe0;
      background: transparent;
      color: #17202a;
      font: 800 1.45rem/1 system-ui, sans-serif;
      cursor: pointer;
    }
    #simu-reliable-zoom button:last-child { border-bottom: 0; }
    #simu-reliable-zoom button:hover { background: #e8f3fa; color: #14699f; }
  `;
  document.head.appendChild(style);
}

function installControlStateSync(view: any): void {
  const sync = (): void => {
    if (!view.controls) return;
    view.controls.enabled = !document.body.classList.contains('selection-active');
  };
  sync();
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

function installPointerZoom(element: HTMLElement, controller: ZoomController): void {
  const pointers = new Map<number, Point>();
  let previousDistance = 0;

  element.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch') return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [first, second] = [...pointers.values()];
      previousDistance = Math.hypot(second.x - first.x, second.y - first.y);
    }
  }, { capture: true });

  element.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'touch' || !pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size !== 2) return;

    const [first, second] = [...pointers.values()];
    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    if (previousDistance > 0 && distance > 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      controller.zoomBy(clamp(previousDistance / distance, 0.78, 1.28));
    }
    previousDistance = distance;
  }, { capture: true, passive: false });

  const release = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) previousDistance = 0;
  };
  element.addEventListener('pointerup', release, { capture: true });
  element.addEventListener('pointercancel', release, { capture: true });
}

function installZoom(view: any, element: HTMLElement, standalone: boolean): void {
  if (installedViews.has(view)) return;
  installedViews.add(view);
  installInteractionStyles();
  installControlStateSync(view);

  const controller = createZoomController(view);
  element.addEventListener('wheel', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (document.body.classList.contains('selection-active')) return;
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;

    const pixels = wheelPixels(event);
    if (!Number.isFinite(pixels) || pixels === 0) return;
    const strength = clamp(Math.max(0.045, Math.abs(pixels) * 0.0024), 0.045, 0.34);
    controller.zoomBy(Math.exp(Math.sign(pixels) * strength));
  }, { capture: true, passive: false });

  installPointerZoom(element, controller);
  addZoomButtons(element, controller, standalone);

  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      controller.zoomBy(0.68);
    } else if (event.key === '-') {
      event.preventDefault();
      controller.zoomBy(1.48);
    }
  });
}

function installStandaloneExitGuard(): void {
  if (!window.location.pathname.endsWith('/lidar.html')) return;
  const guardState = { ...(history.state ?? {}), simuLidarViewerGuard: true };
  let explicitExit = false;

  history.replaceState(guardState, '', window.location.href);
  history.pushState(guardState, '', window.location.href);

  window.addEventListener('popstate', () => {
    if (explicitExit) return;
    window.setTimeout(() => history.forward(), 0);
  });

  const backButton = document.querySelector<HTMLButtonElement>('#back-to-map');
  backButton?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    explicitExit = true;
    const referrer = document.referrer ? new URL(document.referrer) : null;
    if (referrer?.origin === window.location.origin && !referrer.pathname.endsWith('/lidar.html')) {
      history.go(-2);
      window.setTimeout(() => window.location.replace('/'), 500);
    } else {
      window.location.replace('/');
    }
  }, { capture: true });
}

function findViewHost(standalone: boolean): HTMLElement | null {
  return document.querySelector<HTMLElement>(standalone ? '#lidar-viewer' : '#map-surface');
}

async function initializeReliableNavigation(): Promise<void> {
  const standalone = window.location.pathname.endsWith('/lidar.html');
  installStandaloneExitGuard();

  for (let attempt = 0; attempt < 300; attempt += 1) {
    const view = window.__SIM_ITOWNS__?.view;
    const host = findViewHost(standalone);
    if (view?.controls && host) {
      installZoom(view, host, standalone);
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  console.error('[Navigation iTowns] Vue introuvable, zoom fiable non installé.');
}

void initializeReliableNavigation();
