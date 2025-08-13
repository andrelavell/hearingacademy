export function scoreRelated(a, b) {
  // a: {category, tags[]}, b: same
  const tagSetA = new Set((a.tags || []).map((t) => t.toLowerCase()));
  const tagSetB = new Set((b.tags || []).map((t) => t.toLowerCase()));
  let overlap = 0;
  for (const t of tagSetA) if (tagSetB.has(t)) overlap++;
  const catBonus = a.category && b.category && a.category === b.category ? 1 : 0;
  return overlap * 2 + catBonus; // simple heuristic
}

export function pickRelated(index, target, { limit = 4, excludeSlug } = {}) {
  const candidates = index
    .filter((it) => it.slug !== excludeSlug)
    .map((it) => ({ it, score: scoreRelated(target, it) }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map(({ it }) => ({ slug: it.slug, title: it.title, category: it.category }));
  return candidates;
}

export function appendFurtherReadingToBody(body, related) {
  if (!related || related.length === 0) return body;
  const list = related
    .map((r) => `- <a href="/articles/${r.slug}">${escapeHtml(r.title)}</a> (${r.category})`)
    .join('\n');
  const block = `\n\n<h2>Further Reading</h2>\n\n${list}\n`;
  return body.trimEnd() + block + '\n';
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
