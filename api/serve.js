import { get } from '@vercel/blob';
import { unzipSync } from 'fflate';

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json', map: 'application/json', webmanifest: 'application/manifest+json',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', xml: 'application/xml',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
};

const cache = new Map(); // garde les sites récents en mémoire (économise les lectures Blob)

async function load(site) {
  const hit = cache.get(site);
  if (hit && Date.now() - hit.t < 60_000) return hit.files;
  const r = await get(`sites/${site}.zip`, { access: 'private' }).catch(() => null);
  if (!r || !r.stream) return null;
  const files = unzipSync(new Uint8Array(await new Response(r.stream).arrayBuffer()));
  if (cache.size > 20) cache.clear();
  cache.set(site, { t: Date.now(), files });
  return files;
}

export default async function handler(req, res) {
  const site = String(req.query.site || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(site)) return res.status(404).send('Site introuvable');
  const files = await load(site);
  if (!files) return res.status(404).send('Site introuvable');

  let p = String(req.query.path || '').replace(/^\/+/, '');
  if (!p || p.endsWith('/')) p += 'index.html';
  const name = [p, `${p}/index.html`, `${p}.html`].find((n) => files[n]);
  const use = name || (files['404.html'] ? '404.html' : null);
  if (!use) return res.status(404).send('Page introuvable');

  const ext = use.split('.').pop().toLowerCase();
  const base = `/u/${site}/`;
  let out = Buffer.from(files[use]);
  if (ext === 'html' || ext === 'htm') {
    // les liens "/style.css" pointent vers le site, et <base> gère les liens relatifs
    let s = out.toString('utf8').replace(/(\s(?:src|href|action)=["'])\/(?!\/)/gi, `$1${base}`);
    s = /<head[^>]*>/i.test(s) ? s.replace(/<head[^>]*>/i, (m) => `${m}<base href="${base}">`) : `<base href="${base}">${s}`;
    out = Buffer.from(s);
  } else if (ext === 'css') {
    out = Buffer.from(out.toString('utf8').replace(/url\((["']?)\/(?!\/)/g, `url($1${base}`));
  }

  res.status(name ? 200 : 404);
  res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  res.send(out);
}
