import matter from 'gray-matter';
import readingTime from 'reading-time';
import slugify from 'slugify';

// NOTE: Articles are .astro files using <ArticleLayout ...> props, not frontmatter.
// We provide helpers to parse props from the layout tag and to build article files.

const ATTR_RE = /<ArticleLayout([\s\S]*?)>/m;
const ATTR_PAIR_RE = /(\w+)={(\[[\s\S]*?\])}|(\w+)="([\s\S]*?)"/g;

export function parseArticleAstro(content) {
  const m = content.match(ATTR_RE);
  if (!m) return null;
  const attrBlock = m[1];
  const props = {};
  let match;
  while ((match = ATTR_PAIR_RE.exec(attrBlock)) !== null) {
    if (match[1] && match[2]) {
      // array/object like tags={["a", "b"]}
      const key = match[1];
      try {
        props[key] = eval(match[2]); // eslint-disable-line no-eval
      } catch {
        // fallback naive parse
        props[key] = [];
      }
    } else if (match[3] && match[4]) {
      const key = match[3];
      props[key] = match[4];
    }
  }
  // Body inside the slot
  const bodyStart = content.indexOf('>\n', m.index) + 2;
  const closeTag = '</ArticleLayout>';
  const bodyEnd = content.indexOf(closeTag, bodyStart);
  const body = bodyEnd > -1 ? content.slice(bodyStart, bodyEnd).trim() : '';

  const stats = readingTime(stripHtml(body));
  return { props, body, readingTime: stats.text, words: stats.words };
}

export function buildArticleAstro({
  title,
  description,
  publishedTime,
  modifiedTime,
  author,
  authorTitle,
  category,
  tags,
  image,
  imageAlt,
  imageCredit,
  imageCreditUrl,
  readingTime,
  body
}) {
  const tagsArray = Array.isArray(tags) ? tags : [];
  const tagsAstro = `{${JSON.stringify(tagsArray)}}`;
  return `---\nimport ArticleLayout from '../../layouts/ArticleLayout.astro';\n---\n\n<ArticleLayout\n  title="${escapeAttr(title)}"\n  description="${escapeAttr(description)}"\n  publishedTime="${escapeAttr(publishedTime)}"\n  modifiedTime="${escapeAttr(modifiedTime || publishedTime)}"\n  author="${escapeAttr(author)}"\n  authorTitle="${escapeAttr(authorTitle)}"\n  category="${escapeAttr(category)}"\n  tags=${tagsAstro}\n  image="${escapeAttr(image)}"\n  imageAlt="${escapeAttr(imageAlt || title)}"\n  imageCredit="${escapeAttr(imageCredit || '')}"\n  imageCreditUrl="${escapeAttr(imageCreditUrl || '')}"\n  readingTime="${escapeAttr(readingTime)}"\n>\n${body.trim()}\n</ArticleLayout>\n`;
}

export function makeSlug(title) {
  return slugify(title, { lower: true, strict: true, trim: true });
}

export function makeCompactSlug({ title, keywords = [], maxLen = 60, maxWords = 6 }) {
  const base = String(title || '');
  const kw = Array.isArray(keywords) ? keywords : [];
  const terms = (base + ' ' + kw.join(' '))
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const stop = new Set([
    'the','a','an','and','or','but','to','of','in','on','for','with','without','that','this','these','those','your','youre','is','are','be','as','by','from','at','it','its','into','about','what','when','how','why','we','our'
  ]);
  const dedup = [];
  for (const t of terms) {
    if (stop.has(t)) continue;
    if (!dedup.includes(t)) dedup.push(t);
  }

  const priority = ['hearing','hearing-aids','audiogram','tinnitus','ear','audiology','hearing-loss','hidden','noise','protection','tests','technology','treatment','prevention'];
  const prioritized = [...dedup].sort((a,b) => {
    const ia = priority.indexOf(a);
    const ib = priority.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  const words = prioritized.slice(0, maxWords);
  let slug = slugify(words.join(' '), { lower: true, strict: true, trim: true });
  if (slug.length > maxLen) {
    while (words.length > 1 && slug.length > maxLen) {
      words.pop();
      slug = slugify(words.join(' '), { lower: true, strict: true, trim: true });
    }
  }
  if (!slug) slug = makeSlug(title);
  return slug;
}

function escapeAttr(s) {
  return String(s || '').replace(/"/g, '\\"');
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ');
}
