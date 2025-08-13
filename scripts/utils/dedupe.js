import crypto from 'node:crypto';

export function normalizeTopic(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function topicHash({ title, category, tags = [], keywords = [] }) {
  const base = [normalizeTopic(title), normalizeTopic(category), ...tags.map(normalizeTopic), ...keywords.map(normalizeTopic)]
    .filter(Boolean)
    .join('|');
  return crypto.createHash('sha256').update(base).digest('hex');
}

export function jaccard(a, b) {
  const A = new Set(a.map((s) => normalizeTopic(s)));
  const B = new Set(b.map((s) => normalizeTopic(s)));
  const inter = new Set([...A].filter((x) => B.has(x)));
  const union = new Set([...A, ...B]);
  return union.size === 0 ? 0 : inter.size / union.size;
}
