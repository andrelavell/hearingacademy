import path from 'node:path';
import fs from 'node:fs/promises';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';

// Helpers copied/adapted from episodes.ts for standalone usage
async function githubGetJson(relPath: string): Promise<any | null> {
  try {
    const token = String(process.env.GITHUB_TOKEN || '').trim();
    const repo = String(process.env.GITHUB_REPO || '').trim(); // owner/name
    const branch = String(process.env.GITHUB_BRANCH || 'main').trim();
    if (!token || !repo) return null;
    const [owner, name] = repo.split('/');
    if (!owner || !name) return null;

    const getUrl = `https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(relPath)}?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'HearingAcademy-Uploader' } });
    if (!res.ok) return null;
    const j: any = await res.json();
    if (!j || !j.content) return null;
    const buf = Buffer.from(String(j.content), 'base64');
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

async function githubGetBinary(relPath: string): Promise<Buffer | null> {
  try {
    const token = String(process.env.GITHUB_TOKEN || '').trim();
    const repo = String(process.env.GITHUB_REPO || '').trim(); // owner/name
    const branch = String(process.env.GITHUB_BRANCH || 'main').trim();
    if (!token || !repo) return null;
    const [owner, name] = repo.split('/');
    if (!owner || !name) return null;

    const getUrl = `https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(relPath)}?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'HearingAcademy-Uploader' } });
    if (!res.ok) return null;
    const j: any = await res.json();
    if (!j || !j.content) return null;
    return Buffer.from(String(j.content), 'base64');
  } catch {
    return null;
  }
}

async function githubCommitFilesFromContents(files: Array<{ path: string; content: Buffer | string }>, message: string): Promise<{ ok: boolean; details?: any }> {
  try {
    const token = String(process.env.GITHUB_TOKEN || '').trim();
    const repo = String(process.env.GITHUB_REPO || '').trim(); // owner/name
    const branch = String(process.env.GITHUB_BRANCH || 'main').trim();
    if (!token || !repo) return { ok: false, details: 'Missing GITHUB_TOKEN or GITHUB_REPO' };
    const [owner, name] = repo.split('/');
    if (!owner || !name) return { ok: false, details: 'GITHUB_REPO must be owner/name' };

    const gh = async (url: string, init?: any) => {
      const res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'HearingAcademy-Uploader',
          ...(init && init.headers || {}),
        },
      });
      if (!res.ok) throw new Error(`${init?.method || 'GET'} ${url} => ${res.status} ${await res.text()}`);
      return res.json();
    };

    const ref = await gh(`https://api.github.com/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(branch)}`);
    const latestSha = ref.object?.sha;
    if (!latestSha) throw new Error('Could not resolve latest commit sha');
    const latestCommit = await gh(`https://api.github.com/repos/${owner}/${name}/git/commits/${latestSha}`);
    const baseTree = latestCommit.tree?.sha;
    if (!baseTree) throw new Error('Could not resolve base tree sha');

    const blobs: Array<{ path: string; sha: string }> = [];
    for (const f of files) {
      const buf = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
      const blob = await gh(`https://api.github.com/repos/${owner}/${name}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }) });
      blobs.push({ path: f.path, sha: blob.sha });
    }

    const tree = await gh(`https://api.github.com/repos/${owner}/${name}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ base_tree: baseTree, tree: blobs.map(b => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })) }),
    });

    const commit = await gh(`https://api.github.com/repos/${owner}/${name}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [latestSha] }) });

    await gh(`https://api.github.com/repos/${owner}/${name}/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });

    return { ok: true };
  } catch (e: any) {
    return { ok: false, details: e?.message || String(e) };
  }
}

async function readEpisodes(localPath: string, readOnly: boolean): Promise<any[]> {
  if (readOnly) {
    const remote = await githubGetJson('src/data/episodes.json');
    return Array.isArray(remote) ? remote : [];
  }
  try {
    const raw = await fs.readFile(localPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeEpisodes(localPath: string, records: any[], readOnly: boolean, extraFiles: Array<{ path: string; content: Buffer | string }> = []) {
  const body = JSON.stringify(records, null, 2) + '\n';
  if (readOnly) {
    const files = [{ path: 'src/data/episodes.json', content: body }, ...extraFiles];
    const gh = await githubCommitFilesFromContents(files, 'episodes: add captions via background transcription');
    if (!gh.ok) throw new Error(gh.details || 'GitHub commit failed');
  } else {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, body, 'utf8');
    for (const f of extraFiles) {
      const abs = path.join(process.cwd(), f.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content);
    }
  }
}

function nowIso() { return new Date().toISOString(); }

async function transcribeToVtt(buf: Buffer, filename: string): Promise<{ vtt: string, text: string }>
{
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');
  const openai = new OpenAI({ apiKey });
  const model = String(process.env.WHISPER_MODEL || 'whisper-1');
  const file = await toFile(buf, filename);
  const tr: any = await openai.audio.transcriptions.create({
    file,
    model,
    response_format: 'verbose_json',
    temperature: 0,
  } as any);
  const segments: Array<{ start: number; end: number; text: string }> = Array.isArray(tr?.segments)
    ? tr.segments.map((s: any) => ({ start: Number(s.start || 0), end: Number(s.end || 0), text: String(s.text || '') }))
    : [{ start: 0, end: Math.max(0, Number(tr?.duration || 0)), text: String(tr?.text || '') }];
  const lines: string[] = ['WEBVTT', ''];
  let i = 1;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const timeToVtt = (ts: number) => {
    const h = Math.floor(ts / 3600);
    const m = Math.floor((ts % 3600) / 60);
    const s = Math.floor(ts % 60);
    const ms = Math.round((ts - Math.floor(ts)) * 1000);
    return `${pad(h)}:${pad(m)}:${pad(s)}.${String(ms).padStart(3, '0')}`;
  };
  for (const seg of segments) {
    lines.push(String(i++));
    lines.push(`${timeToVtt(seg.start)} --> ${timeToVtt(seg.end)}`);
    lines.push(seg.text.trim());
    lines.push('');
  }
  return { vtt: lines.join('\n'), text: String(tr?.text || '') };
}

export const handler = async (event: any) => {
  try {
    const READ_ONLY = (process.env.NETLIFY === 'true') || !!process.env.AWS_REGION || !!process.env.AWS_EXECUTION_ENV || !!process.env.LAMBDA_TASK_ROOT;
    const EPISODES_JSON = path.join(process.cwd(), 'src', 'data', 'episodes.json');

    const method = String(event.httpMethod || 'POST').toUpperCase();
    if (method !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };

    const b = (() => { try { return JSON.parse(event.body || '{}'); } catch { return {}; } })();
    const slug = String(b.slug || event.queryStringParameters?.slug || '').trim();
    if (!slug) return { statusCode: 400, body: JSON.stringify({ error: 'Missing slug' }) };

    const episodes = await readEpisodes(EPISODES_JSON, READ_ONLY);
    const idx = episodes.findIndex((e: any) => e.slug === slug);
    if (idx === -1) return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
    const rec = episodes[idx];

    const audio = String(rec.audio || '').trim();
    if (!audio) return { statusCode: 400, body: JSON.stringify({ error: 'No audio found on record' }) };

    // Load audio into buffer
    let buf: Buffer | null = null;
    let ext = (audio.toLowerCase().endsWith('.wav') ? 'wav' : 'mp3');
    if (/^https?:\/\//i.test(audio)) {
      const res = await fetch(audio);
      if (!res.ok) return { statusCode: 502, body: JSON.stringify({ error: `Fetch audio failed: ${res.status}` }) };
      const ab = await res.arrayBuffer();
      buf = Buffer.from(ab);
      const urlExt = (new URL(audio)).pathname.toLowerCase();
      if (urlExt.endsWith('.wav')) ext = 'wav';
    } else {
      const rel = `public/${audio.replace(/^\//, '')}`;
      if (READ_ONLY) {
        buf = await githubGetBinary(rel);
      } else {
        const abs = path.join(process.cwd(), rel);
        try { buf = await fs.readFile(abs); } catch { buf = null; }
      }
    }

    if (!buf) return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load audio bytes' }) };

    // Transcribe
    const { vtt } = await transcribeToVtt(buf, `${slug}.${ext}`);

    // Choose captions folder based on audio path year-month if present
    let ym = '';
    const m = audio.match(/\/episodes\/audio\/(\d{4}-\d{2})\//);
    if (m) ym = m[1];
    if (!ym) {
      const now = new Date();
      ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    const vttRel = `public/episodes/captions/${ym}/${slug}.vtt`;

    // Update record and write files
    const updated = { ...rec, captions: vttRel.replace(/^public\//, '/'), modifiedAt: nowIso() };
    const next = [...episodes];
    next[idx] = updated;

    await writeEpisodes(EPISODES_JSON, next, READ_ONLY, [{ path: vttRel, content: vtt }]);

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, data: { slug, captions: updated.captions } }) };
  } catch (e: any) {
    console.error('[episodes-transcribe-background] failed:', e?.stack || e?.message || e);
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || 'Server error' }) };
  }
};
