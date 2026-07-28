const viewer = document.querySelector<HTMLElement>('#lidar-viewer');
const backButton = document.querySelector<HTMLButtonElement>('#back-to-map');

const HISTORY_GUARD = 'simulateur-lidar-history-guard';
let explicitNavigation = false;

function cameFromMap(): boolean {
  if (!document.referrer) return false;
  try {
    const referrer = new URL(document.referrer);
    return referrer.origin === window.location.origin
      && (referrer.pathname === '/' || referrer.pathname.endsWith('/index.html'));
  } catch {
    return false;
  }
}

function installHistoryGuard(): void {
  const state = {
    ...(window.history.state ?? {}),
    [HISTORY_GUARD]: true,
  };

  // La seconde entrée portant exactement la même URL absorbe les gestes
  // précédent/suivant générés par Edge, un pavé tactile ou un écran tactile.
  window.history.replaceState(state, '', window.location.href);
  window.history.pushState({ ...state, depth: 1 }, '', window.location.href);

  window.addEventListener('popstate', () => {
    if (explicitNavigation) return;
    window.history.pushState({ ...state, depth: 1 }, '', window.location.href);
  });
}

function installGestureGuards(): void {
  if (!viewer) return;

  // Empêche le navigateur de convertir un mouvement horizontal ou un geste
  // tactile en navigation d'historique. L'événement reste transmis à iTowns.
  viewer.addEventListener('wheel', (event) => {
    event.preventDefault();
  }, { passive: false, capture: true });

  viewer.addEventListener('dragstart', (event) => event.preventDefault());

  const preventBrowserGesture = (event: Event): void => {
    event.preventDefault();
  };

  document.addEventListener('gesturestart', preventBrowserGesture, { passive: false } as AddEventListenerOptions);
  document.addEventListener('gesturechange', preventBrowserGesture, { passive: false } as AddEventListenerOptions);
  document.addEventListener('gestureend', preventBrowserGesture, { passive: false } as AddEventListenerOptions);
}

function leaveViewer(): void {
  explicitNavigation = true;

  // Deux entrées en arrière : la garde locale, puis la page LiDAR. Cela permet
  // au navigateur de restaurer la carte précédente depuis son cache lorsque la
  // visionneuse a été ouverte depuis l'application.
  if (cameFromMap() && window.history.length >= 3) {
    window.history.go(-2);
    return;
  }

  window.location.replace('/');
}

installHistoryGuard();
installGestureGuards();

backButton?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
  leaveViewer();
}, { capture: true });
