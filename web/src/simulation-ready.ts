type RenderMode = 'simulation' | 'classification';
type SceneWindow = Window & {
  __SIM_SCENE__?: {
    applyMode(mode: RenderMode): void;
  };
};

const params = new URL(window.location.href).searchParams;
const copcUrl = params.get('copc') ?? '';
const processed = params.get('processed') === '1' || copcUrl.includes('/processed/');

async function waitForViewerCompletion(timeoutMs = 75_000): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const status = document.querySelector<HTMLElement>('#lidar-page-status');
    const scene = (window as SceneWindow).__SIM_SCENE__;
    if (status?.classList.contains('error')) return;
    if (status?.classList.contains('success') && scene) {
      document.body.classList.toggle('simulation-processed', processed);
      document.body.classList.toggle('simulation-raw', !processed);
      scene.applyMode(processed ? 'simulation' : 'classification');
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
  console.warn('[Scène Simulation] La visionneuse n’a pas confirmé sa disponibilité finale.');
}

void waitForViewerCompletion();
