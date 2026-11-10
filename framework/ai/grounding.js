// Grounding guard: every monetary amount in AI-generated text must come from the deterministic
// pricing engine (or be a simple difference between two engine values). Otherwise the text is
// rejected and the template explanation is used instead (PRD §4.4: "The LLM shall not invent prices").

export function collectNumbers(obj, out = new Set()) {
  if (typeof obj === 'number' && Number.isFinite(obj)) out.add(Math.round(obj * 100) / 100);
  else if (Array.isArray(obj)) obj.forEach((v) => collectNumbers(v, out));
  else if (obj && typeof obj === 'object') Object.values(obj).forEach((v) => collectNumbers(v, out));
  else if (typeof obj === 'string') for (const m of obj.matchAll(/\d+(?:\.\d+)?/g)) out.add(Number(m[0]));
  return out;
}

export function extractMoney(text) {
  // Comma-grouped amounts first ($1,234.50), then plain digits ($1234.50) — order matters.
  return [...text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1].replace(/,/g, '')));
}

export function extractPercents(text) {
  return [...text.matchAll(/(\d+(?:\.\d+)?)\s?%/g)].map((m) => Number(m[1]));
}

export function checkGrounding(text, facts) {
  const nums = [...collectNumbers(facts)];
  const allowed = new Set(nums);
  // permit differences / per-month conversions of engine-produced amounts
  for (const a of nums) {
    allowed.add(Math.round((a / 12) * 100) / 100);
    for (const b of nums) allowed.add(Math.round(Math.abs(a - b) * 100) / 100);
  }
  const close = (x) => [...allowed].some((y) => Math.abs(x - y) <= 0.011 || (Number.isInteger(x) && Math.abs(x - y) < 0.5 && !Number.isInteger(y)));
  const ungrounded = extractMoney(text).filter((x) => !close(x));
  // Percentages must be stated in the facts, or be a ratio of two engine values (e.g. "saves 26%").
  const pcts = extractPercents(text);
  if (pcts.length) {
    const ratio = new Set();
    for (const a of nums) for (const b of nums) if (b > 0 && a <= b) ratio.add(Math.round((a / b) * 100)).add(Math.round(((b - a) / b) * 100));
    for (const p of pcts) if (!allowed.has(p) && !ratio.has(Math.round(p))) ungrounded.push(`${p}%`);
  }
  return { grounded: ungrounded.length === 0, ungrounded };
}
