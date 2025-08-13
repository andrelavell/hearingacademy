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
  add('/about/', { changefreq: 'monthly', priority: '0.6' });
  add('/contact/', { changefreq: 'monthly', priority: '0.5' });
  add('/privacy/', { changefreq: 'yearly', priority: '0.3' });
  add('/terms/', { changefreq: 'yearly', priority: '0.3' });

  const list = Array.isArray(topics) ? topics : [];
  // Articles
  for (const it of list) {
    if (!it?.slug) continue;
    add(`/articles/${it.slug}/`, { lastmod: it.modifiedTime || it.publishedTime || now, changefreq: 'monthly', priority: '0.8' });
  }

  // Categories (only those present in categories.json)
  const cats = Array.isArray(categories) ? categories : [];
  for (const c of cats) {
    const slug = String(c).toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
    // include only if at least one article exists
    const has = list.some((it) => it.category === c);
    if (has) add(`/category/${slug}/`, { changefreq: 'weekly', priority: '0.6' });
  }

  // Tags (discovered from index)
  const tagSet = new Set<string>();
  for (const it of list) {
    for (const t of (Array.isArray(it.tags) ? it.tags : [])) tagSet.add(String(t));
  }
  for (const t of Array.from(tagSet)) {
    const slug = String(t).toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
    add(`/tags/${slug}/`, { changefreq: 'weekly', priority: '0.5' });
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
