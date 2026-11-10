// Minimal Anthropic Messages API client (no SDK dependency).

export async function callClaude({ apiKey, model, system, messages, tools, maxTokens = 700, timeoutMs = 12000, fetchImpl = fetch }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, ...(tools ? { tools } : {}) }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Claude API error ${res.status}: ${json.error?.message ?? 'unknown'}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}
