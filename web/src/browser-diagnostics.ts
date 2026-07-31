const apiUrl = ((import.meta.env.VITE_API_URL as string | undefined) ?? 'http://127.0.0.1:8000').replace(/\/$/, '');
let installed = false;

function safeString(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function sendDiagnostic(payload: Record<string, unknown>): void {
  const body = JSON.stringify({
    ts: new Date().toISOString(),
    page: window.location.href,
    userAgent: navigator.userAgent,
    ...payload,
  });
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(`${apiUrl}/diagnostics/frontend`, blob);
      return;
    }
  } catch {
    // fallback fetch ci-dessous
  }
  void fetch(`${apiUrl}/diagnostics/frontend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => undefined);
}

export function installBrowserDiagnostics(): void {
  if (installed) return;
  installed = true;
  sendDiagnostic({ type: 'page-load' });

  window.addEventListener('error', (event) => {
    sendDiagnostic({
      type: 'window-error',
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: safeString(event.error),
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    sendDiagnostic({ type: 'unhandled-rejection', reason: safeString(event.reason) });
  });

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const startedAt = performance.now();
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    try {
      const response = await originalFetch(input as RequestInfo, init);
      const durationMs = Math.round(performance.now() - startedAt);
      if (!response.ok || url.includes('/lidar/') || url.includes('/diagnostics/')) {
        sendDiagnostic({ type: 'fetch', method, url, status: response.status, ok: response.ok, durationMs });
      }
      return response;
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      sendDiagnostic({ type: 'fetch-error', method, url, durationMs, error: safeString(error) });
      throw error;
    }
  };
}

installBrowserDiagnostics();
