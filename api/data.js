// api/data.js — remplace window.storage (qui n'existe que dans les Artifacts Claude)
// par un vrai stockage partagé côté serveur (Vercel KV), pour que tous les
// employés de la boutique voient le même stock/ventes/comptes.

const { kv } = require('@vercel/kv');

const ALLOWED_KEYS = new Set(['products', 'sales', 'accounts', 'settings']);

module.exports = async (req, res) => {
  const key = (req.query && req.query.key) || '';

  if (!ALLOWED_KEYS.has(key)) {
    res.status(400).json({ error: 'Clé invalide' });
    return;
  }

  if (req.method === 'GET') {
    try {
      const value = await kv.get(key);
      res.status(200).json({ value: value === undefined ? null : value });
    } catch (e) {
      console.error('Erreur lecture KV:', e);
      res.status(500).json({ error: 'Erreur de lecture' });
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      await kv.set(key, body.value);
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error('Erreur écriture KV:', e);
      res.status(500).json({ error: "Erreur d'écriture" });
    }
    return;
  }

  res.status(405).json({ error: 'Méthode non supportée' });
};
