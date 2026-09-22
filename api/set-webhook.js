// api/set-webhook.js — petit endpoint pratique pour dire à Telegram où envoyer
// les updates, sans avoir besoin d'installer quoi que ce soit en local.
// Une fois déployé, visite (dans le navigateur) :
//   https://TON-SITE.vercel.app/api/set-webhook?secret=TON_SETUP_SECRET
// Tu peux ensuite désactiver/supprimer cet endpoint si tu veux.

module.exports = async (req, res) => {
  const TOKEN = process.env.BOT_TOKEN;
  const SITE_URL = process.env.SITE_URL;
  const SETUP_SECRET = process.env.SETUP_SECRET || '';

  if (SETUP_SECRET && req.query.secret !== SETUP_SECRET) {
    res.status(401).send('Unauthorized');
    return;
  }
  if (!TOKEN || !SITE_URL) {
    res.status(400).json({ error: 'BOT_TOKEN ou SITE_URL manquant dans les variables d\'environnement' });
    return;
  }

  const webhookUrl = `${SITE_URL.replace(/\/$/, '')}/api/telegram`;
  const params = new URLSearchParams({ url: webhookUrl });
  if (process.env.WEBHOOK_SECRET) params.set('secret_token', process.env.WEBHOOK_SECRET);

  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook?${params.toString()}`);
    const result = await r.json();
    res.status(200).json({ webhookUrl, telegramResponse: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
