// Redact personal data from customer free text before it is sent to the LLM (PRD §7: avoid
// sending unnecessary personal or payment information to the AI model).

const PATTERNS = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[card-or-account-number]'],
  [/(?:\+?\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}\b/g, '[phone]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[id-number]'],
  [/\b(?:https?:\/\/)\S+/gi, '[link]'],
];

export function redactPII(text) {
  let out = String(text ?? '');
  for (const [re, label] of PATTERNS) out = out.replace(re, label);
  return out;
}
