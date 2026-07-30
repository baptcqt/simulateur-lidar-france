type RuntimeState = {
  view?: any;
  layers: Map<string, any>;
};

declare global {
  interface Window {
    __SIM_ITOWNS__?: RuntimeState;
  }
}

let suppressSelectionRecenterUntil = 0;
let buttonHooked = false;
let controlsPatched = false;

function markSelectionClick(): void {
  // main.ts appelle encore setCameraMode('flat') quand on démarre une sélection.
  // Cette action ne doit pas déplacer la carte : on neutralise uniquement le
  // lookAtCoordinate déclenché immédiatement par ce clic, sans toucher aux
  // recentrages voulus depuis la recherche ou les dalles locales.
  suppressSelectionRecenterUntil = performance.now() + 700;
}

function hookSelectionButton(): void {
  if (buttonHooked) return;
  const button = document.querySelector<HTMLButtonElement>('#select-rectangle');
  if (!button) return;
  button.addEventListener('click', markSelectionClick, { capture: true });
  buttonHooked = true;
}

function patchMapControls(): void {
  if (controlsPatched) return;
  const view = window.__SIM_ITOWNS__?.view;
  const controls = view?.controls;
  if (!view || !controls?.lookAtCoordinate) return;

  const originalLookAtCoordinate = controls.lookAtCoordinate.bind(controls);
  controls.lookAtCoordinate = (options: unknown) => {
    if (performance.now() < suppressSelectionRecenterUntil) {
      suppressSelectionRecenterUntil = 0;
      view.notifyChange(view.camera3D);
      return Promise.resolve();
    }
    return originalLookAtCoordinate(options);
  };
  controlsPatched = true;
}

function installSelectionGuard(): void {
  hookSelectionButton();
  patchMapControls();
  if (!buttonHooked || !controlsPatched) {
    window.setTimeout(installSelectionGuard, 100);
  }
}

installSelectionGuard();
