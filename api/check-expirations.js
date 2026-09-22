// api/check-expirations.js — remplace le setInterval(..., 60*60*1000) de bot.js,
// impossible en serverless (rien ne tourne en continu). Vercel Cron appelle
// cette URL une fois par heure (voir vercel.json) pour faire le même travail.

const TelegramBot = require('node-telegram-bot-api');
const store = require('../lib/botStore');

const TOKEN = process.env.BOT_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET || '';

const bot = new TelegramBot(TOKEN, { polling: false });

const PLAN_LABELS = {
  free: 'Acces gratuit',
  decouverte: 'Decouverte (1 000 FCFA/mois)',
  pro: 'Pro (2 500 FCFA/mois)',
  business: 'Business (5 000 FCFA/mois)'
};

function genPassword() {
  return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 4);
}
function adminIds(data) {
  const ids = new Set(data.admins.map(a => a.id));
  if (data.ownerId) ids.add(data.ownerId);
  return [...ids];
}
async function notifyAdmins(data, text, opts) {
  await Promise.all(adminIds(data).map(id => bot.sendMessage(id, text, opts).catch(() => {})));
}

module.exports = async (req, res) => {
  // Vercel Cron envoie un header Authorization: Bearer <CRON_SECRET> si tu le configures.
  if (CRON_SECRET && req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    res.status(401).send('Unauthorized');
    return;
  }

  const data = await store.load();
  const now = Date.now();
  let changed = false;
  let expiredCount = 0;

  for (const [username, account] of Object.entries(data.accounts)) {
    if (account.plan === 'free') continue;
    if (account.status !== 'active') continue;
    if (!account.expiresAt) continue;
    if (new Date(account.expiresAt).getTime() > now) continue;

    account.password = genPassword();
    account.status = 'expired';
    changed = true;
    expiredCount++;

    await bot.sendMessage(account.telegramId, "Ton abonnement Kaisse est arrive a expiration. Ton acces est suspendu en attendant le renouvellement.").catch(() => {});

    await notifyAdmins(
      data,
      `Abonnement expire : *${account.displayName}* (@${username}) — ${PLAN_LABELS[account.plan]}.\nRenouveler pour un mois de plus ?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Oui, renouveler', callback_data: `renew:yes:${username}` },
            { text: '❌ Non', callback_data: `renew:no:${username}` }
          ]]
        }
      }
    );
  }

  if (changed) await store.save(data);
  res.status(200).json({ ok: true, comptesVerifies: Object.keys(data.accounts).length, expires: expiredCount });
};
