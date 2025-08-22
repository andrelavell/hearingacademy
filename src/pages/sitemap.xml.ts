import topics from '../data/topics_index.json';
import categories from '../data/categories.json';

export async function GET() {
  const BASE = (import.meta as any)?.env?.SITE_BASE_URL || process.env.SITE_BASE_URL || 'https://hearingacademy.org';
  const now = new Date().toISOString();
  const urls: { loc: string; lastmod?: string; changefreq?: string; priority?: string }[] = [];

  const add = (path: string, opts: Partial<{ lastmod: string; changefreq: string; priority: string }> = {}) => {
    const normalized = path.startsWith('http') ? path : `${BASE}${path}`;
    urls.push({ loc: normalized, lastmod: opts.lastmod || now, changefreq: opts.changefreq || 'weekly', priority: opts.priority || '0.7' });
  };

  // Core pages
  add('/',{ priority: '1.0' });
  add('/articles/', { priority: '0.9' });
  // Reviews section (index)
  add('/reviews/', { priority: '0.9' });
  add('/about/', { changefreq: 'monthly', priority: '0.6' });
  add('/contact/', { changefreq: 'monthly', priority: '0.5' });
  add('/privacy/', { changefreq: 'yearly', priority: '0.3' });
  add('/terms/', { changefreq: 'yearly', priority: '0.3' });

  const list = Array.isArray(topics) ? topics : [];
  // Track newest dates for categories and tags
  const toISO = (ms: number) => new Date(ms).toISOString();
  const parseDateNum = (d?: string) => {
    const n = Date.parse(String(d || ''));
    return isNaN(n) ? 0 : n;
  };
  const categoryNewest = new Map<string, number>();
  const tagNewest = new Map<string, number>();
  // Articles
  for (const it of list) {
    if (!it?.slug) continue;
    const lm = it.modifiedTime || it.publishedTime || now;
    add(`/articles/${it.slug}/`, { lastmod: lm, changefreq: 'monthly', priority: '0.8' });
    // update newest for category
    if (it.category) {
      const prev = categoryNewest.get(it.category) || 0;
      const cur = parseDateNum(it.modifiedTime || it.publishedTime) || 0;
      if (cur > prev) categoryNewest.set(it.category, cur);
    }
    // update newest for tags
    const tags = Array.isArray(it.tags) ? it.tags : [];
    const cur = parseDateNum(it.modifiedTime || it.publishedTime) || 0;
    for (const t of tags) {
      const prevT = tagNewest.get(String(t)) || 0;
      if (cur > prevT) tagNewest.set(String(t), cur);
    }
  }

  // Reviews (scan markdown in /reviews)
  const reviewModules = import.meta.glob('./reviews/*.md', { eager: true }) as Record<string, any>;
  for (const [path, mod] of Object.entries(reviewModules)) {
    const fm = (mod as any)?.frontmatter || {};
    const slug = path.replace('./reviews/', '').replace(/\.md$/, '');
    const lm = fm.modifiedTime || fm.publishedTime || now;
    add(`/reviews/${slug}/`, {
      lastmod: lm,
      changefreq: 'monthly',
      priority: '0.8'
    });
    // update newest for tags (reviews use tags, not categories)
    const reviewTags = Array.isArray(fm.tags) ? fm.tags : [];
    const cur = parseDateNum(fm.modifiedTime || fm.publishedTime) || 0;
    for (const t of reviewTags) {
      const prevT = tagNewest.get(String(t)) || 0;
      if (cur > prevT) tagNewest.set(String(t), cur);
    }
  }

  // Categories (only those present in categories.json)
  const cats = Array.isArray(categories) ? categories : [];
  for (const c of cats) {
    const slug = String(c).toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
    // include only if at least one article exists
    const has = list.some((it) => it.category === c);
    if (has) {
      const newest = categoryNewest.get(String(c)) || 0;
      add(`/category/${slug}/`, { lastmod: newest ? toISO(newest) : now, changefreq: 'weekly', priority: '0.6' });
    }
  }

  // Tags (discovered from index)
  // Prefer tag keys from aggregated newest map (includes reviews + articles)
  for (const t of Array.from(tagNewest.keys())) {
    const slug = String(t).toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
    const newest = tagNewest.get(String(t)) || 0;
    add(`/tags/${slug}/`, { lastmod: newest ? toISO(newest) : now, changefreq: 'weekly', priority: '0.5' });
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map(u => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`)
    .join('\n')}\n</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml',
    },
  });
}
