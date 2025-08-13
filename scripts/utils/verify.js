import 'dotenv/config';
import https from 'node:https';
import { URL } from 'node:url';

function timeoutSignal(ms = 6000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(new Error('timeout')), ms);
  return { signal: ac.signal, cancel: () => clearTimeout(id) };
}

async function fetchWithFallback(url, opts = {}) {
  // Prefer global fetch if available (Node 18+), else use https
  if (typeof fetch === 'function') {
    const { signal, cancel } = timeoutSignal(opts.timeoutMs || 6000);
    try {
      const res = await fetch(url, { ...opts, redirect: 'follow', signal });
      cancel();
      return { ok: res.ok, status: res.status, url: res.url, headers: res.headers };
    } catch (e) {
      cancel();
      throw e;
    }
  }
  // https fallback (basic GET)
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 6000);
      const req = https.request({
        method: 'GET',
        protocol: u.protocol,
        hostname: u.hostname,
        path: u.pathname + (u.search || ''),
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        headers: { 'User-Agent': 'HearingAcademyBot/1.0' },
        signal: controller.signal,
      }, (res) => {
        clearTimeout(timer);
        // drain data quickly and abort early
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, url, headers: new Map(Object.entries(res.headers || {})) });
      });
      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

export async function verifyUrl(url, { timeoutMs = 6000 } = {}) {
  if (!url || typeof url !== 'string') return { ok: false, status: 0, url };
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, status: 0, url: u };

  // Try HEAD first, fallback to GET
  try {
    const head = await fetchWithFallback(u, { method: 'HEAD', timeoutMs });
    if (head.ok) return { ok: true, status: head.status, url: head.url };
    // Some sites reject HEAD; fall through to GET
  } catch (_) {
    // ignore and try GET
  }
  try {
    const get = await fetchWithFallback(u, { method: 'GET', timeoutMs });
    return { ok: get.ok, status: get.status, url: get.url };
  } catch (e) {
    return { ok: false, status: 0, url: u };
  }
}

export async function verifyReferences(refs = [], { timeoutMs = 6000, max = 8 } = {}) {
  const seen = new Map();
  const out = [];
  for (const r of Array.isArray(refs) ? refs : []) {
    const label = String(r?.label || '').trim();
    const url = String(r?.url || '').trim();
    if (!label || !url) continue;
    if (!seen.has(url)) {
      seen.set(url, verifyUrl(url, { timeoutMs }));
    }
    try {
      const res = await seen.get(url);
      if (res?.ok) out.push({ label, url: res.url || url });
    } catch (_) {
      // ignore failures
    }
    if (out.length >= max) break;
  }
  return out;
}
