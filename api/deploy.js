import { put, get } from '@vercel/blob';
import { unzipSync, zipSync } from 'fflate';
import { createHash, randomBytes } from 'node:crypto';

const MAX_UPLOAD = 4_400_000; // Vercel limite le corps d'une requête à ~4,5 Mo
const MAX_TOTAL = 10_000_000; // taille max d'un site décompressé
const OK_EXT = new Set('html htm css js mjs json txt md xml svg png jpg jpeg gif webp avif ico woff woff2 ttf otf map webmanifest mp3 mp4 webm pdf'.split(' '));

const sha = (s) => createHash('sha256').update(s).digest('hex');

async function readBlob(pathname) {
  try {
    const r = await get(pathname, { access: 'private' });
    if (!r || !r.stream) return null;
    return Buffer.from(await new Response(r.stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function readBody(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > MAX_UPLOAD) throw new Error('Fichier trop gros : 4 Mo maximum.');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function extract(buf) {
  let total = 0;
  const raw = unzipSync(buf, {
    filter: (f) => {
      total += f.originalSize;
      if (total > MAX_TOTAL) throw new Error('Site trop gros : 10 Mo maximum décompressé.');
      return !f.name.endsWith('/');
    },
  });
  const names = Object.keys(raw).filter((n) => !n.startsWith('__MACOSX/'));
  // retire le dossier racine commun (zip GitHub ou dossier zippé)
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const strip = tops.size === 1 && names.every((n) => n.includes('/')) ? [...tops][0] + '/' : '';
  const out = {};
  for (const n of names) {
    const p = n.slice(strip.length);
    const parts = p.split('/');
    if (parts.some((s) => !s || s.startsWith('.'))) continue;
    if (!OK_EXT.has(p.split('.').pop().toLowerCase())) continue;
    out[p] = raw[n];
  }
  return out;
}

export default async function handler(req, res) {
  const fail = (code, error) => res.status(code).json({ error });
  if (req.method !== 'POST') return fail(405, 'POST uniquement');

  const q = new URL(req.url, 'http://x').searchParams;
  const site = (q.get('site') || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(site)) {
    return fail(400, 'Nom invalide : 2 à 31 caractères (a-z, 0-9, tiret).');
  }

  try {
    let files;
    const repo = q.get('repo');
    if (repo) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail(400, 'Dépôt invalide : utilise owner/repo.');
      const branch = q.get('branch');
      const url = `https://api.github.com/repos/${repo}/zipball${branch ? '/' + encodeURIComponent(branch) : ''}`;
      const headers = { 'User-Agent': 'hebergeur' };
      if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      const r = await fetch(url, { headers });
      if (!r.ok) return fail(400, 'Dépôt ou branche introuvable (les dépôts privés ne sont pas pris en charge).');
      files = extract(new Uint8Array(await r.arrayBuffer()));
    } else if (q.get('type') === 'html') {
      files = { 'index.html': new Uint8Array(await readBody(req)) };
    } else {
      const buf = await readBody(req);
      if (buf[0] !== 0x50 || buf[1] !== 0x4b) return fail(400, "Ce fichier n'est pas un zip valide.");
      files = extract(new Uint8Array(buf));
    }

    if (!files['index.html']) return fail(400, 'Il faut un index.html à la racine du site.');

    // Propriété du site : on ne stocke que le hash du token
    const token = req.headers['x-token'];
    const metaPath = `sites/${site}.json`;
    const meta = await readBlob(metaPath);
    let newToken;
    if (meta) {
      if (!token || sha(token) !== JSON.parse(meta.toString()).hash) {
        return fail(403, 'Ce nom est déjà pris : token manquant ou incorrect.');
      }
    } else {
      newToken = randomBytes(16).toString('hex');
      try {
        await put(metaPath, JSON.stringify({ hash: sha(newToken) }), { access: 'private', contentType: 'application/json' });
      } catch {
        return fail(409, 'Ce nom vient d\'être pris.');
      }
    }

    await put(`sites/${site}.zip`, Buffer.from(zipSync(files)), {
      access: 'private',
      allowOverwrite: true,
      contentType: 'application/zip',
    });
    res.json({ url: `/u/${site}/`, files: Object.keys(files).length, token: newToken });
  } catch (e) {
    fail(400, e.message || 'Erreur pendant le déploiement.');
  }
}
