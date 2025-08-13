import { load } from 'cheerio';

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

// Inline linking
const STOP = new Set([
  'the','a','an','and','or','but','to','of','in','on','for','with','without','that','this','these','those','your','is','are','be','as','by','from','at','it','its','into','about','what','when','how','why','we','our',
  // Generic SEO/medical filler
  'health','research','guide','guides','tips','basics','overview','introduction','intro','article','blog','post'
]);

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function deriveAnchorsFromTitle(title, { minWords = 2, maxWords = 4 } = {}) {
  const words = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !STOP.has(w));
  if (!words.length) return [];
  const slice = words.slice(0, maxWords);
  if (slice.length < minWords) return [];
  const phrase = slice.join(' ');
  return phrase ? [phrase] : [];
}

function getItemBySlug(index, slug) {
  return index.find((it) => it.slug === slug);
}

function tokensFor(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter((w) => !STOP.has(w))
  );
}

function tokensIntersect(aSet, bSet) {
  for (const t of aSet) if (bSet.has(t)) return true;
  return false;
}

export function injectInlineLinks(bodyHtml, index, target, { maxInline = 4 } = {}) {
  try {
    const $ = load(String(bodyHtml || ''), { decodeEntities: false });
    const usedAnchors = new Set();
    const usedHrefs = new Set();

    // Pick candidate targets using existing heuristic
    const related = pickRelated(index, { category: target.category, tags: target.tags }, { limit: Math.max(6, maxInline * 2) });

    const candidates = [];
    for (const r of related) {
      const item = getItemBySlug(index, r.slug) || { title: r.title, tags: [] };
      const itemTags = (item.tags || []).map((t) => String(t || '').toLowerCase().trim()).filter(Boolean);
      const tagTokenSet = new Set(itemTags.flatMap((t) => Array.from(tokensFor(t))));

      const anchors = [];
      // Prefer tag-based anchors (allow single word)
      for (const t of itemTags) {
        if (t.length >= 3 && t.length <= 60) {
          const toks = tokensFor(t);
          anchors.push({ text: t, type: 'tag', tokens: toks, tokenCount: toks.size });
        }
      }
      // Title-derived anchors: require multi-word and overlap with tag tokens for relevance
      for (const p of deriveAnchorsFromTitle(item.title, { minWords: 2, maxWords: 4 })) {
        const toks = tokensFor(p);
        if (toks.size >= 2 && (tagTokenSet.size === 0 || tokensIntersect(toks, tagTokenSet))) {
          anchors.push({ text: p, type: 'title', tokens: toks, tokenCount: toks.size });
        }
      }
      // Prefer more specific (more tokens) anchors first
      anchors.sort((a, b) => b.tokenCount - a.tokenCount);
      const href = `/articles/${r.slug}`;
      candidates.push({ href, anchors, tagTokenSet });
    }

    let placed = 0;
    const blocks = $('p, li');
    blocks.each((_, el) => {
      if (placed >= maxInline) return false; // break
      const $el = $(el);
      if ($el.find('a').length) return; // skip if already contains links (avoid clutter)

      // Try to place one link per block
      for (const c of candidates) {
        if (placed >= maxInline) break;
        if (usedHrefs.has(c.href)) continue;
        for (const a of c.anchors) {
          const anchor = a.text;
          if (!anchor || usedAnchors.has(anchor)) continue;
          // Only allow single-word anchors if they are tag-based
          const isSingleWord = anchor.trim().split(/\s+/).length === 1;
          if (isSingleWord && a.type !== 'tag') continue;
          // For title-derived anchors, ensure overlap with target tag tokens
          if (a.type === 'title' && c.tagTokenSet && c.tagTokenSet.size > 0 && !tokensIntersect(a.tokens, c.tagTokenSet)) continue;

          const re = new RegExp(escapeRegex(anchor), 'i');
          const nodes = $el.contents().toArray();
          let linked = false;
          for (const node of nodes) {
            if (linked) break;
            if (node.type === 'text') {
              const txt = node.data || '';
              const m = re.exec(txt);
              if (m) {
                const i = m.index;
                const before = txt.slice(0, i);
                const matchText = txt.slice(i, i + m[0].length);
                const after = txt.slice(i + m[0].length);
                const linkHtml = `${before}<a href="${c.href}">${matchText}</a>${after}`;
                $(node).replaceWith(linkHtml);
                usedAnchors.add(anchor);
                usedHrefs.add(c.href);
                placed++;
                linked = true;
              }
            }
          }
          if (linked) break;
        }
      }
    });

    return $.html();
  } catch (e) {
    // If anything fails, return original body
    return String(bodyHtml || '');
  }
}
