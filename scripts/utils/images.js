import fs from 'node:fs/promises';
import path from 'node:path';

export async function downloadToPublic(url, slug, id) {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dir = path.join(process.cwd(), 'public', 'images', 'articles', ym);
  await fs.mkdir(dir, { recursive: true });
  const filename = `${slug}-pexels-${id}.jpg`;
  const filePath = path.join(dir, filename);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(filePath, buf);

  const publicPath = `/images/articles/${ym}/${filename}`;
  return { filePath, publicPath };
}
