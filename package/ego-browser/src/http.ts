/**
 * Fetch text over HTTP with a browser-like User-Agent.
 * @param {string} url URL to fetch.
 * @param {{headers?: Record<string,string>, timeout?: number}} [options]
 * @returns {Promise<string>} Response body text.
 */
export async function httpGet(url, options: any = {}) {
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", ...(options.headers || {}) },
    signal: AbortSignal.timeout((options.timeout ?? 20.0) * 1000)
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  }
  return response.text();
}
