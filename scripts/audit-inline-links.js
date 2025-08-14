#!/usr/bin/env node
import path from 'node:path';
import { load } from 'cheerio';
import { listArticleFiles, readFile, readJSON, DATA_DIR } from './utils/fs.js';
import { parseArticleAstro } from './utils/astroArticle.js';

// NOTE: This is a read-only audit. It does not modify article files.
// It mirrors the anchor→candidate scoring used by injectInlineLinks() to check
// whether current inline links point to topically optimal targets.

const STOP = new Set([
  'the','a','an','and','or','but','to','of','in','on','for','with','without','that','this','these','those','your','is','are','be','as','by','from','at','it','its','into','about','what','when','how','why','we','our',
  // Generic SEO/medical filler
  'health','research','guide','guides','tips','basics','overview','introduction','intro','article','blog','post',
  // Generic medical terms (avoid as anchor tokens)
  'treatment','treatments','therapy','therapies','management','symptom','symptoms','cause','causes','diagnosis','diagnose','prevention','options','care','types','type','test','tests','testing','risk','risks','signs','factors','procedure','procedures','medical'
]);
const SINGLE_WORD_BLOCKLIST = new Set([
  'treatment','treatments','therapy','management','diagnosis','prevention','types','tests','testing','care','options','causes','cause','symptoms','risk','risks','signs'
]);
const GENERIC_DOMAIN_TOKENS = new Set([
  'hearing','loss','ear','ears','aid','aids','tinnitus','noise','sound','speech','score','scores','test','tests','clinic','clinical','audiology','audiologist','health','care','research'
]);

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
function tokensIntersect(aSet, bSet) { for (const t of aSet) if (bSet.has(t)) return true; return false; }
function countIntersect(aSet, bSet) { let c = 0; for (const t of aSet) if (bSet.has(t)) c++; return c; }

function buildAllCandidates(index, current) {
  return index
    .filter((it) => it.slug !== current.slug)
    .map((it) => {
      const itemTags = (it.tags || []).map((t) => String(t || '').toLowerCase().trim()).filter(Boolean);
      const tagTokenSet = new Set(itemTags.flatMap((t) => Array.from(tokensFor(t))));
      const titleLower = String(it.title || '').toLowerCase();
      const titleTokenSet = tokensFor(it.title);
      const candidateTokenSet = new Set([...tagTokenSet, ...titleTokenSet]);
      return { href: `/articles/${it.slug}`, itemTags, tagTokenSet, titleTokenSet, candidateTokenSet, titleLower };
    });
}

function scoreAnchorAgainstCandidate(anchor, aTokens, candidate, targetTagTokenSet, targetTitleTokenSet) {
  const isSingle = anchor.trim().split(/\s+/).length === 1;
  let score = 0;
  if (candidate.itemTags.includes(anchor)) score += 6;
  const overlapCount = countIntersect(aTokens, candidate.candidateTokenSet);
  score += overlapCount * 4;
  const coverage = aTokens.size ? overlapCount / aTokens.size : 0;
  if (coverage >= 0.67) score += 3; else if (coverage >= 0.5) score += 2; else if (coverage < 0.34) score -= 3;
  if (candidate.titleLower.includes(anchor.toLowerCase())) score += 3;
  if (tokensIntersect(aTokens, targetTagTokenSet)) score += 2;
  if (tokensIntersect(aTokens, targetTitleTokenSet)) score += 1;
  if (!isSingle) score += 1;
  return score;
}

async function loadIndex() {
  const p = path.join(DATA_DIR, 'topics_index.json');
  const idx = await readJSON(p, []);
  return Array.isArray(idx) ? idx : [];
}

function getSlugFromHref(href) {
  try {
    const u = new URL(href, 'https://example.com');
    const m = u.pathname.match(/^\/articles\/(.+)$/);
    if (!m) return null;
    const raw = m[1];
    return raw.replace(/\/$/, '').split('/')[0];
  } catch { return null; }
}

async function auditArticle(filePath, index) {
  const content = await readFile(filePath, 'utf8');
  const parsed = parseArticleAstro(content);
  if (!parsed) return { filePath, error: 'parse-failed' };
  const { props, body } = parsed;
  const current = { slug: path.basename(filePath, '.astro'), title: props.title, tags: props.tags || [], category: props.category };
  const $ = load(body || '', { decodeEntities: false });

  // Compute target token sets for context boosts
  const targetTagTokenSet = new Set((current.tags || []).flatMap((t) => Array.from(tokensFor(t))));
  const targetTitleTokenSet = tokensFor(current.title || '');
  const allCandidates = buildAllCandidates(index, current);

  const blocks = $('p, li').toArray();
  const links = [];

  for (const el of blocks) {
    const $el = $(el);
    // Skip links under a preceding H2 titled "Further Reading"
    const prevH2 = $el.prevAll('h2').first();
    if (prevH2.length && prevH2.text().trim().toLowerCase() === 'further reading') continue;
    $el.find('a[href^="/articles/"]').each((_, a) => {
      const $a = $(a);
      const href = String($a.attr('href') || '').trim();
      const slug = getSlugFromHref(href);
      const anchor = ($a.text() || '').trim();
      if (!href || !slug || !anchor) return;
      links.push({ href, slug, anchor });
    });
  }

  const MIN_ANCHOR_SCORE = 8;
  const results = [];

  for (const link of links) {
    const anchor = link.anchor;
    const aTokens = tokensFor(anchor);
    if (aTokens.size === 0) {
      results.push({ ...link, skipped: 'no-meaningful-tokens' });
      continue;
    }
    const isSingle = anchor.trim().split(/\s+/).length === 1;
    if (isSingle && SINGLE_WORD_BLOCKLIST.has(anchor)) {
      results.push({ ...link, skipped: 'single-word-blocklisted' });
      continue;
    }
    const nonGenericAnchorTokens = new Set(Array.from(aTokens).filter((t) => !GENERIC_DOMAIN_TOKENS.has(t)));
    // Build scored list for all candidates
    const scored = [];
    for (const c of allCandidates) {
      const overlapCount = countIntersect(aTokens, c.candidateTokenSet);
      if (overlapCount === 0) continue;
      if (nonGenericAnchorTokens.size > 0 && countIntersect(nonGenericAnchorTokens, c.candidateTokenSet) === 0) continue;
      const score = scoreAnchorAgainstCandidate(anchor, aTokens, c, targetTagTokenSet, targetTitleTokenSet);
      scored.push({ href: c.href, score });
    }
    scored.sort((x, y) => y.score - x.score);

    const rank = scored.findIndex((s) => s.href === link.href) + 1;
    const chosen = scored.find((s) => s.href === link.href) || null;
    const best = scored[0] || null;
    const passTop1 = rank === 1;
    const passTop3 = rank > 0 && rank <= 3;
    const passScore = chosen ? chosen.score >= MIN_ANCHOR_SCORE : false;

    results.push({ ...link, score: chosen?.score ?? null, rank: rank || null, bestHref: best?.href || null, bestScore: best?.score ?? null, passTop1, passTop3, passScore });
  }

  const counted = results.filter((r) => !r.skipped);
  const top1 = counted.filter((r) => r.passTop1).length;
  const top3 = counted.filter((r) => r.passTop3).length;
  const goodScore = counted.filter((r) => r.passScore).length;
  const flagged = counted.filter((r) => !(r.passTop3 && r.passScore));

  return {
    filePath,
    slug: current.slug,
    title: current.title,
    totalLinks: counted.length,
    pctTop1: counted.length ? +(100 * top1 / counted.length).toFixed(1) : 0,
    pctTop3: counted.length ? +(100 * top3 / counted.length).toFixed(1) : 0,
    pctScoreOK: counted.length ? +(100 * goodScore / counted.length).toFixed(1) : 0,
    flagged: flagged.slice(0, 10), // cap per-article detail
  };
}

async function main() {
  const args = process.argv.slice(2);
  const limitArgIdx = args.indexOf('--limit');
  const limit = limitArgIdx !== -1 ? parseInt(args[limitArgIdx + 1], 10) : null;

  const index = await loadIndex();
  const files = await listArticleFiles();
  // Optionally limit to the most recent N by index order (index is unshifted on create)
  let filesToAudit = files;
  if (limit && Number.isFinite(limit)) {
    const recentSlugs = index.slice(0, limit).map((it) => it.slug);
    const recentSet = new Set(recentSlugs);
    filesToAudit = files.filter((f) => recentSet.has(path.basename(f, '.astro')));
  }

  const perArticle = [];
  for (const f of filesToAudit) {
    try {
      const res = await auditArticle(f, index);
      if (!res.error) perArticle.push(res);
    } catch (e) {
      console.error('[audit] failed for', f, e?.message || e);
    }
  }

  const totals = perArticle.reduce((acc, r) => {
    acc.links += r.totalLinks;
    acc.top1 += Math.round((r.pctTop1 / 100) * r.totalLinks);
    acc.top3 += Math.round((r.pctTop3 / 100) * r.totalLinks);
    acc.scoreOK += Math.round((r.pctScoreOK / 100) * r.totalLinks);
    return acc;
  }, { links: 0, top1: 0, top3: 0, scoreOK: 0 });

  const overall = totals.links ? {
    pctTop1: +(100 * totals.top1 / totals.links).toFixed(1),
    pctTop3: +(100 * totals.top3 / totals.links).toFixed(1),
    pctScoreOK: +(100 * totals.scoreOK / totals.links).toFixed(1),
  } : { pctTop1: 0, pctTop3: 0, pctScoreOK: 0 };

  // Print concise report
  console.log('=== Inline Link Relevance Audit ===');
  console.log('Articles audited:', perArticle.length);
  console.log('Overall % Top-1:', overall.pctTop1);
  console.log('Overall % Top-3:', overall.pctTop3);
  console.log('Overall % Score>=8:', overall.pctScoreOK);
  console.log('');
  for (const r of perArticle) {
    const flagged = r.flagged || [];
    console.log(`- ${r.title} [${r.slug}] -> links=${r.totalLinks}, top1%=${r.pctTop1}, top3%=${r.pctTop3}, scoreOK%=${r.pctScoreOK}, flagged=${flagged.length}`);
    for (const f of flagged) {
      console.log(`    • anchor="${f.anchor}" -> chosen={href:${f.href}, score:${f.score}, rank:${f.rank}} best={href:${f.bestHref}, score:${f.bestScore}}`);
    }
  }
}

main().catch((e) => {
  console.error('[audit] Fatal:', e);
  process.exit(1);
});
