import path from 'node:path';
import fs from 'node:fs/promises';
import { Busboy } from '@fastify/busboy';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';

// Reuse storage approach used elsewhere: write to repo locally or via GitHub API when on Netlify (read-only FS)

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

async function githubPutFileFromContent(relPath: string, content: Buffer | string, message: string): Promise<{ ok: boolean; details?: any }> {
  try {
    const token = String(process.env.GITHUB_TOKEN || '').trim();
    const repo = String(process.env.GITHUB_REPO || '').trim(); // owner/name
    const branch = String(process.env.GITHUB_BRANCH || 'main').trim();
    if (!token || !repo) return { ok: false, details: 'Missing GITHUB_TOKEN or GITHUB_REPO' };
    const [owner, name] = repo.split('/');
    if (!owner || !name) return { ok: false, details: 'GITHUB_REPO must be owner/name' };

    const getUrl = `https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(relPath)}?ref=${encodeURIComponent(branch)}`;
    let sha: string | undefined;
    try {
      const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'HearingAcademy-Uploader' } });
      if (getRes.ok) {
        const j: any = await getRes.json();
        if (j && j.sha) sha = j.sha;
      }
    } catch {}

    const putUrl = `https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(relPath)}`;
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const body: any = { message, content: buf.toString('base64'), branch, sha };
    const res = await fetch(putUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'HearingAcademy-Uploader' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { ok: false, details: `GitHub PUT failed for ${relPath}: ${res.status} ${txt}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, details: e?.message || String(e) };
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

function parseMultipart(body: Buffer, contentType: string): Promise<{ fields: Record<string, string>, files: Record<string, { data: Buffer, filename?: string, mimeType?: string }> }>
{
  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    const files: Record<string, { data: Buffer, filename?: string, mimeType?: string }> = {};
    const bb = Busboy({ headers: { 'content-type': contentType } as any });

    bb.on('field', (name: string, val: string) => { fields[name] = val; });
    bb.on('file', (_name: string, stream: any, info: any) => {
      const chunks: Buffer[] = [];
      stream.on('data', (d: Buffer) => chunks.push(d));
      stream.on('limit', () => console.warn('[episodes-fn] file size limit reached'));
      stream.on('end', () => {
        files[_name] = { data: Buffer.concat(chunks), filename: info?.filename, mimeType: info?.mimeType };
      });
    });
    bb.on('error', reject);
    bb.on('finish', () => resolve({ fields, files }));

    bb.end(body);
  });
}

function makeSlug(input: string): string {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function timeToVtt(ts: number): string {
  const h = Math.floor(ts / 3600);
  const m = Math.floor((ts % 3600) / 60);
  const s = Math.floor(ts % 60);
  const ms = Math.round((ts - Math.floor(ts)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

function buildVttFromSegments(segments: Array<{ start: number; end: number; text: string }>): string {
  const lines: string[] = ['WEBVTT', ''];
  let i = 1;
  for (const seg of segments) {
    const start = timeToVtt(seg.start);
    const end = timeToVtt(seg.end);
    lines.push(String(i++));
    lines.push(`${start} --> ${end}`);
    lines.push(seg.text.trim());
    lines.push('');
  }
  return lines.join('\n');
}

async function transcribeToVtt(buf: Buffer, filename: string): Promise<{ vtt: string, text: string }>
{
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');
  const openai = new OpenAI({ apiKey });
  // Request verbose_json to build VTT reliably
  // Model preference: 'gpt-4o-transcribe' if available, else 'whisper-1'
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
  const vtt = buildVttFromSegments(segments);
  return { vtt, text: String(tr?.text || '') };
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
    const gh = await githubCommitFilesFromContents(files, 'episodes: update episodes.json and assets');
    if (!gh.ok) throw new Error(gh.details || 'GitHub commit failed');
  } else {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, body, 'utf8');
    // Also write extra files to disk
    for (const f of extraFiles) {
      const abs = path.join(process.cwd(), f.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content);
    }
  }
}

function nowIso() { return new Date().toISOString(); }

export const handler = async (event: any) => {
  try {
    const READ_ONLY = (process.env.NETLIFY === 'true') || !!process.env.AWS_REGION || !!process.env.AWS_EXECUTION_ENV || !!process.env.LAMBDA_TASK_ROOT;
    const EPISODES_JSON = path.join(process.cwd(), 'src', 'data', 'episodes.json');

    const method = String(event.httpMethod || 'GET').toUpperCase();
    const qs = event.queryStringParameters || {};

    if (method === 'GET') {
      const episodes = await readEpisodes(EPISODES_JSON, READ_ONLY);
      const slug = String(qs.slug || '').trim();
      const data = slug ? episodes.find((e: any) => e.slug === slug) || null : episodes;
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, data }) };
    }

    if (method === 'DELETE') {
      const slug = String(qs.slug || '').trim();
      if (!slug) return { statusCode: 400, body: JSON.stringify({ error: 'Missing slug' }) };
      const episodes = await readEpisodes(EPISODES_JSON, READ_ONLY);
      const next = episodes.filter((e: any) => e.slug !== slug);
      await writeEpisodes(EPISODES_JSON, next, READ_ONLY);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    if (method === 'PATCH' || method === 'PUT') {
      // JSON only update metadata, optional: views increment
      const body = (() => { try { return JSON.parse(event.body || '{}'); } catch { return {}; } })();
      const slug = String(body.slug || qs.slug || '').trim();
      if (!slug) return { statusCode: 400, body: JSON.stringify({ error: 'Missing slug' }) };
      const episodes = await readEpisodes(EPISODES_JSON, READ_ONLY);
      const idx = episodes.findIndex((e: any) => e.slug === slug);
      if (idx === -1) return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };

      // Increment op support: { op: 'inc', field: 'views', by?: number }
      if (String(body.op || '').toLowerCase() === 'inc' && String(body.field || '').toLowerCase() === 'views') {
        const by = Number(body.by);
        const incBy = Number.isFinite(by) ? by : 1;
        const cur = Number(episodes[idx].views || 0);
        episodes[idx].views = Math.max(0, cur + incBy);
        episodes[idx].modifiedAt = nowIso();
        await writeEpisodes(EPISODES_JSON, episodes, READ_ONLY);
        return { statusCode: 200, body: JSON.stringify({ ok: true, data: episodes[idx] }) };
      }

      const patch: any = {};
      const fields = ['title','body','rating','views'];
      for (const f of fields) if (body[f] !== undefined) patch[f] = body[f];
      if (patch.rating !== undefined) patch.rating = Math.max(0, Math.min(5, Number(patch.rating)));
      if (patch.views !== undefined) patch.views = Math.max(0, Number(patch.views));
      episodes[idx] = { ...episodes[idx], ...patch, modifiedAt: nowIso() };
      await writeEpisodes(EPISODES_JSON, episodes, READ_ONLY);
      return { statusCode: 200, body: JSON.stringify({ ok: true, data: episodes[idx] }) };
    }

    if (method === 'POST') {
      const ct = String(event.headers?.['content-type'] || event.headers?.['Content-Type'] || '');
      const isMultipart = ct.includes('multipart/form-data');
      let fields: Record<string, string> = {};
      let files: Record<string, { data: Buffer, filename?: string, mimeType?: string }> = {};
      if (isMultipart) {
        const bodyBuf = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8');
        const parsed = await parseMultipart(bodyBuf, ct);
        fields = parsed.fields; files = parsed.files;
      } else {
        const json = (() => { try { return JSON.parse(event.body || '{}'); } catch { return {}; } })();
        fields = json; files = {} as any;
      }

      const title = String(fields.title || '').trim();
      let slug = String(fields.slug || '').trim();
      const bodyText = String(fields.body || '').trim();
      const rating = Number(fields.rating || 0);
      const views = Number(fields.views || 0);
      if (!title) return { statusCode: 400, body: JSON.stringify({ error: 'Missing title' }) };
      if (!slug) slug = makeSlug(title);

      const audioFile = files['audio'] || files['mp3'] || null;
      const hasAudio = !!(audioFile && audioFile.data && audioFile.data.length);
      if (!hasAudio && !fields.audioUrl) return { statusCode: 400, body: JSON.stringify({ error: 'Missing audio file or audioUrl' }) };

      const episodes = await readEpisodes(EPISODES_JSON, READ_ONLY);
      if (episodes.some((e: any) => e.slug === slug)) return { statusCode: 409, body: JSON.stringify({ error: 'Slug already exists' }) };

      const now = new Date();
      const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const audioDirRel = `public/episodes/audio/${ym}`;
      const vttDirRel = `public/episodes/captions/${ym}`;

      let audioRelPath: string = '';
      let captionRelPath: string = '';
      const extraFiles: Array<{ path: string; content: Buffer | string }> = [];

      // Audio handling
      if (hasAudio) {
        const ext = (audioFile?.filename || '').toLowerCase().endsWith('.wav') ? 'wav' : 'mp3';
        const filename = `${slug}.${ext}`;
        audioRelPath = `${audioDirRel}/${filename}`;
        extraFiles.push({ path: audioRelPath, content: audioFile!.data });
      } else if (fields.audioUrl) {
        // Keep remote URL without storing in repo
        audioRelPath = String(fields.audioUrl);
      }

      // Transcribe (only if we have local buffer)
      if (hasAudio) {
        try {
          const { vtt } = await transcribeToVtt(audioFile!.data, audioFile!.filename || `${slug}.mp3`);
          const vttFilename = `${slug}.vtt`;
          captionRelPath = `${vttDirRel}/${vttFilename}`;
          extraFiles.push({ path: captionRelPath, content: vtt });
        } catch (e: any) {
          console.warn('[episodes-fn] transcription failed:', e?.message || e);
          captionRelPath = '';
        }
      } else {
        captionRelPath = '';
      }

      const rec: any = {
        slug,
        title,
        body: bodyText,
        rating: Math.max(0, Math.min(5, isFinite(rating) ? rating : 0)),
        views: isFinite(views) ? views : 0,
        audio: audioRelPath.replace(/^public\//, '/'),
        captions: captionRelPath ? captionRelPath.replace(/^public\//, '/') : '',
        createdAt: nowIso(),
        modifiedAt: nowIso(),
      };

      const next = [rec, ...episodes];
      // Write JSON and assets
      await writeEpisodes(EPISODES_JSON, next, READ_ONLY, extraFiles);

      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, data: rec }) };
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (e: any) {
    console.error('[episodes-fn] failed:', e?.stack || e?.message || e);
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || 'Server error' }) };
  }
};
