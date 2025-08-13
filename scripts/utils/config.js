import path from 'node:path';
import { DATA_DIR, readJSON } from './fs.js';

export async function loadCategories() {
  const p = path.join(DATA_DIR, 'categories.json');
  return (await readJSON(p, [])) || [];
}

export async function loadTags() {
  const p = path.join(DATA_DIR, 'tags.json');
  return (await readJSON(p, [])) || [];
}

export async function loadAuthors() {
  const p = path.join(DATA_DIR, 'authors.json');
  const arr = (await readJSON(p, [])) || [];
  return Array.isArray(arr) ? arr : [];
}

export function envInt(name, def) {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}
