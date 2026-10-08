/**
 * The one HTTP call the LLM judges and the example agent share, over plain
 * fetch so the package keeps zero runtime dependencies.
 */

/**
 * Remove the key, and anything shaped like one, from text that may end up in
 * the console or the report. Some OpenAI-compatible providers echo a masked
 * key in their error body ("sk-ab***yz").
 * @param {string} text
 * @param {string[]} [secrets]
 * @returns {string}
 */
export function redactSecrets(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]');
  return out.replace(/\bsk-[\w*-]+/g, '[redacted]');
}

/** Retry-After is either seconds or an HTTP date. */
function parseRetryAfter(header) {
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

/**
 * POST JSON and return the parsed reply. A non-2xx answer throws an Error
 * with `status`, so the runner retries 429 and 5xx but not a bad key or
 * request, and with `retryAfterMs` when the server sent Retry-After.
 * `apiKey` is scrubbed from the error message.
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {unknown} body
 * @param {{ signal?: AbortSignal, apiKey?: string }} [opts]
 * @returns {Promise<any>}
 */
export async function postJSON(url, headers, body, { signal, apiKey } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = redactSecrets(await res.text(), [apiKey]).slice(0, 200);
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    throw Object.assign(new Error(`HTTP ${res.status}: ${detail}`), { status: res.status, retryAfterMs });
  }
  return res.json();
}
