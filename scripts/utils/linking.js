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
  'health','research','guide','guides','tips','basics','overview','introduction','intro','article','blog','post',
  // Generic medical terms (avoid as anchor tokens)
  'treatment','treatments','therapy','therapies','management','symptom','symptoms','cause','causes','diagnosis','diagnose','prevention','options','care','types','type','test','tests','testing','risk','risks','signs','factors','procedure','procedures','medical'
]);

// Avoid using these as single-word anchor texts entirely
const SINGLE_WORD_BLOCKLIST = new Set([
  'treatment','treatments','therapy','management','diagnosis','prevention','types','tests','testing','care','options','causes','cause','symptoms','risk','risks','signs'
]);

// Tokens that are very common in this domain; require at least one non-generic match
const GENERIC_DOMAIN_TOKENS = new Set([
  'hearing','loss','ear','ears','aid','aids','tinnitus','noise','sound','speech','score','scores','test','tests','clinic','clinical','audiology','audiologist','health','care','research'
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

function countIntersect(aSet, bSet) {
  let c = 0;
  for (const t of aSet) if (bSet.has(t)) c++;
  return c;
}

// Consider an anchor "generic-only" if all its tokens are from very common domain terms
function isGenericOnly(tokenSet) {
  if (!tokenSet || tokenSet.size === 0) return false;
  for (const t of tokenSet) {
    if (!GENERIC_DOMAIN_TOKENS.has(t)) return false;
  }
  return true;
}

export function injectInlineLinks(bodyHtml, index, target, { maxInline = 4 } = {}) {
  try {
    const $ = load(String(bodyHtml || ''), { decodeEntities: false });
    const usedAnchors = new Set();
    const usedHrefs = new Set();
    let placedGeneric = 0; // limit generic-only anchors to keep variety

    // Pick candidate targets using existing heuristic, exclude current article if slug provided
    const related = pickRelated(
      index,
      { category: target.category, tags: target.tags },
      { limit: Math.max(20, maxInline * 5), excludeSlug: target.slug }
    );

    // Token sets for the current article to improve topical relevance
    const targetTagTokenSet = new Set((target.tags || []).flatMap((t) => Array.from(tokensFor(t))));
    const targetTitleTokenSet = tokensFor(target.title || '');

    const candidates = [];
    const anchorTexts = new Set();
    for (const r of related) {
      const item = getItemBySlug(index, r.slug) || { title: r.title, tags: [] };
      const itemTags = (item.tags || []).map((t) => String(t || '').toLowerCase().trim()).filter(Boolean);
      const tagTokenSet = new Set(itemTags.flatMap((t) => Array.from(tokensFor(t))));
      const titleTokenSet = tokensFor(item.title);
      const candidateTokenSet = new Set([...tagTokenSet, ...titleTokenSet]);

      const anchors = [];
      // Prefer tag-based anchors (allow single word)
      for (const t of itemTags) {
        if (t.length >= 3 && t.length <= 60) {
          const toks = tokensFor(t);
          const isSingle = t.trim().split(/\s+/).length === 1;
          if (toks.size === 0) continue; // skip generic-only tags (e.g., 'treatment')
          // Skip generic-only short phrases (e.g., 'hearing aids', 'hearing loss') to favor long-tail
          if (isGenericOnly(toks) && toks.size < 3) continue;
          if (isSingle && SINGLE_WORD_BLOCKLIST.has(t)) continue; // skip low-value single-word anchors
          anchors.push({ text: t, type: 'tag', tokens: toks, tokenCount: toks.size });
          anchorTexts.add(t);
        }
      }
      // Title-derived anchors: require multi-word and overlap with tag tokens for relevance
      for (const p of deriveAnchorsFromTitle(item.title, { minWords: 2, maxWords: 4 })) {
        const toks = tokensFor(p);
        // Require multi-word and overlap with tag tokens for relevance, and avoid generic-only
        if (toks.size >= 2 && !isGenericOnly(toks) && (tagTokenSet.size === 0 || tokensIntersect(toks, tagTokenSet))) {
          anchors.push({ text: p, type: 'title', tokens: toks, tokenCount: toks.size });
          anchorTexts.add(p);
        }
      }
      // Prefer more specific (more tokens) anchors first
      anchors.sort((a, b) => b.tokenCount - a.tokenCount);
      const href = `/articles/${r.slug}`;
      candidates.push({ href, anchors, tagTokenSet, titleTokenSet, candidateTokenSet, itemTags, titleLower: String(item.title || '').toLowerCase() });
    }

    // Build anchor -> candidate list with per-anchor relevance score
    const anchorMap = new Map();
    for (const c of candidates) {
      for (const a of c.anchors) {
        const anchor = a.text;
        if (!anchor) continue;
        const isSingleWord = anchor.trim().split(/\s+/).length === 1;
        if (a.tokens.size === 0) continue; // skip anchors with no meaningful tokens
        if (isSingleWord && SINGLE_WORD_BLOCKLIST.has(anchor)) continue; // skip blocked single words
        // Compute relevance score for this anchor->target pairing
        let score = 0;
        // Exact tag match gets highest priority
        if (a.type === 'tag' && c.itemTags.includes(anchor)) score += 6;
        // Strongly weight direct anchor-token overlap with candidate tokens
        const overlapCount = countIntersect(a.tokens, c.candidateTokenSet);
        score += overlapCount * 4;
        const coverage = a.tokens.size ? overlapCount / a.tokens.size : 0;
        if (coverage >= 0.67) score += 3; else if (coverage >= 0.5) score += 2; else if (coverage < 0.34) score -= 3;
        // Exact phrase present in candidate title
        if (c.titleLower && c.titleLower.includes(String(anchor).toLowerCase())) score += 3;
        // Light boost if anchor is also topically relevant to the CURRENT article
        if (tokensIntersect(a.tokens, targetTagTokenSet)) score += 2;
        if (tokensIntersect(a.tokens, targetTitleTokenSet)) score += 1;
        // Slight boost for multi-word anchors
        if (!isSingleWord) score += 1;
        // Require at least one non-generic token match to avoid very broad links
        const nonGenericAnchorTokens = new Set(Array.from(a.tokens).filter((t) => !GENERIC_DOMAIN_TOKENS.has(t)));
        const nonGenericOverlap = countIntersect(nonGenericAnchorTokens, c.candidateTokenSet);
        if (nonGenericAnchorTokens.size > 0 && nonGenericOverlap === 0) continue; // skip weakly matched, generic anchors
        // Penalize anchors that are entirely generic (still allowed if they strongly fit)
        if (isGenericOnly(a.tokens)) score -= 3;
        if (!anchorMap.has(anchor)) anchorMap.set(anchor, []);
        anchorMap.get(anchor).push({ href: c.href, score, type: a.type });
      }
    }
    // Global candidate set (entire index, excluding current) to ensure anchors pick the best target across the site
    const allCandidates = index
      .filter((it) => it.slug !== target.slug)
      .map((it) => {
        const itemTags = (it.tags || []).map((t) => String(t || '').toLowerCase().trim()).filter(Boolean);
        const tagTokenSet = new Set(itemTags.flatMap((t) => Array.from(tokensFor(t))));
        const titleLower = String(it.title || '').toLowerCase();
        const titleTokenSet = tokensFor(it.title);
        const candidateTokenSet = new Set([...tagTokenSet, ...titleTokenSet]);
        return { href: `/articles/${it.slug}`, itemTags, tagTokenSet, titleTokenSet, candidateTokenSet, titleLower };
      });

    for (const anchor of anchorTexts) {
      const aTokens = tokensFor(anchor);
      if (aTokens.size === 0) continue;
      const isSingle = anchor.trim().split(/\s+/).length === 1;
      if (isSingle && SINGLE_WORD_BLOCKLIST.has(anchor)) continue;
      // Require at least one non-generic token if any exist in the anchor
      const nonGenericAnchorTokens = new Set(Array.from(aTokens).filter((t) => !GENERIC_DOMAIN_TOKENS.has(t)));
      for (const c of allCandidates) {
        const overlapCount = countIntersect(aTokens, c.candidateTokenSet);
        if (overlapCount === 0) continue;
        if (nonGenericAnchorTokens.size > 0 && countIntersect(nonGenericAnchorTokens, c.candidateTokenSet) === 0) continue;
        let score = 0;
        // exact tag match
        if (c.itemTags.includes(anchor)) score += 6;
        score += overlapCount * 4;
        const coverage = aTokens.size ? overlapCount / aTokens.size : 0;
        if (coverage >= 0.67) score += 3; else if (coverage >= 0.5) score += 2; else if (coverage < 0.34) score -= 3;
        if (c.titleLower.includes(anchor.toLowerCase())) score += 3;
        if (tokensIntersect(aTokens, targetTagTokenSet)) score += 2;
        if (tokensIntersect(aTokens, targetTitleTokenSet)) score += 1;
        if (!isSingle) score += 1;
        if (nonGenericAnchorTokens.size === 0) score -= 3; // penalize generic-only anchors globally, lightly
        if (!anchorMap.has(anchor)) anchorMap.set(anchor, []);
        anchorMap.get(anchor).push({ href: c.href, score, type: 'global' });
      }
    }
    // Deduplicate options by href and keep highest score, then sort
    for (const [anchor, arr] of anchorMap) {
      const bestByHref = new Map();
      for (const opt of arr) {
        const prev = bestByHref.get(opt.href);
        if (!prev || opt.score > prev.score) bestByHref.set(opt.href, opt);
      }
      anchorMap.set(anchor, Array.from(bestByHref.values()).sort((x, y) => y.score - x.score));
    }
    // Sort candidate lists by score desc
    for (const [k, arr] of anchorMap) arr.sort((x, y) => y.score - x.score);

    let placed = 0;
    const blocks = $('p, li');
    const MIN_ANCHOR_SCORE = 8; // require stronger topical fit
    blocks.each((_, el) => {
      if (placed >= maxInline) return false; // break
      const $el = $(el);
      if ($el.find('a').length) return; // skip if already contains links (avoid clutter)

      // Try to place one link per block: evaluate anchors present in this block and pick best target
      const anchorsByLength = Array.from(anchorMap.keys()).sort((a, b) => b.length - a.length);
      for (const anchor of anchorsByLength) {
        if (placed >= maxInline) break;
        if (usedAnchors.has(anchor)) continue;
        const isSingleWordAnchor = anchor.trim().split(/\s+/).length === 1;
        const re = isSingleWordAnchor ? new RegExp(`\\b${escapeRegex(anchor)}\\b`, 'i') : new RegExp(escapeRegex(anchor), 'i');
        const nodes = $el.contents().toArray();
        let idxNode = -1;
        let matchInfo = null;
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          if (node.type !== 'text') continue;
          const txt = node.data || '';
          const m = re.exec(txt);
          if (m) { idxNode = i; matchInfo = { m, txt }; break; }
        }
        if (idxNode === -1) continue; // anchor not present in this block
        // Pick best target for this anchor
        const options = anchorMap.get(anchor) || [];
        const target = options.find((opt) => !usedHrefs.has(opt.href) && opt.score >= MIN_ANCHOR_SCORE);
        if (!target) continue;
        // Enforce per-article limit on generic-only anchors to encourage long-tail diversity
        const aTokens = tokensFor(anchor);
        if (isGenericOnly(aTokens) && placedGeneric >= 1) continue;
        // Insert link
        const node = nodes[idxNode];
        const i = matchInfo.m.index;
        const before = matchInfo.txt.slice(0, i);
        const matchText = matchInfo.txt.slice(i, i + matchInfo.m[0].length);
        const after = matchInfo.txt.slice(i + matchInfo.m[0].length);
        const linkHtml = `${before}<a href="${target.href}">${matchText}</a>${after}`;
        $(node).replaceWith(linkHtml);
        usedAnchors.add(anchor);
        usedHrefs.add(target.href);
        placed++;
        if (isGenericOnly(aTokens)) placedGeneric++;
        break; // one link per block
      }
    });

    return $.html();
  } catch (e) {
    // If anything fails, return original body
    return String(bodyHtml || '');
  }
}
