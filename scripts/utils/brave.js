import 'dotenv/config';

const BRAVE_API_KEY = process.env.BRAVE_API_KEY || '';
const BRAVE_ENDPOINT = process.env.BRAVE_API_ENDPOINT || 'https://api.search.brave.com/res/v1/web/search';

if (!BRAVE_API_KEY) {
  console.warn('[brave] BRAVE_API_KEY not set. Phase 2 features will be disabled.');
}

export async function braveSearchWeb(query, { count = 5, freshness = 'month', country = 'us', safesearch = 'moderate' } = {}) {
  if (!BRAVE_API_KEY) throw new Error('Missing BRAVE_API_KEY');
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));
  url.searchParams.set('freshness', freshness);
  url.searchParams.set('country', country);
  url.searchParams.set('safesearch', safesearch);

  const res = await fetch(url, {
    headers: {
      'X-Subscription-Token': BRAVE_API_KEY,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`[brave] ${res.status}: ${txt.slice(0,200)}`);
  }
  return res.json();
}

export function extractTopResults(json, { max = 5 } = {}) {
  const out = [];
  const web = json?.web?.results || [];
  for (const r of web) {
    if (out.length >= max) break;
    out.push({ title: r?.title || '', url: r?.url || '', description: r?.description || '' });
  }
  return out;
}
