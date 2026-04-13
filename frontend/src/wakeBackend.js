/**
 * Ping the backend /health so platforms that sleep idle instances (e.g. Render free)
 * start waking as soon as the user opens the app. Fire-and-forget; retries in background.
 */
export function wakeBackend(baseUrl, options = {}) {
  const maxAttempts = options.maxAttempts ?? 12;
  const baseDelayMs = options.baseDelayMs ?? 1500;
  const url = `${String(baseUrl).replace(/\/$/, "")}/health`;

  const run = async () => {
    for (let i = 0; i < maxAttempts; i += 1) {
      try {
        const res = await fetch(url, { method: "GET", cache: "no-store", mode: "cors" });
        if (res.ok) return;
      } catch {
        // Cold start or network: retry
      }
      const delay = baseDelayMs * Math.min(i + 1, 5);
      await new Promise((r) => setTimeout(r, delay));
    }
  };

  void run();
}
