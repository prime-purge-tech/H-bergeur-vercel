// api/check-expirations.js — Vercel déclenche cette fonction chaque jour (voir vercel.json).
// Comme il n'y a pas de processus qui tourne en continu, on ne peut pas faire un
// setInterval comme sur un vrai serveur : on vérifie une fois par jour à la place.

const TelegramBot = require('node-telegram-bot-api');
const { loadData, saveData } = require('../lib/kv');

const TOKEN = process.env.BOT_TOKEN;
const bot = new TelegramBot(TOKEN);

const PLAN_LABELS = {
  free: 'Accès gratuit',
  decouverte: 'Découverte (1 000 FCFA/mois)',
  pro: 'Pro (2 500 FCFA/mois)',
  business: 'Business (5 000 FCFA/mois)'
};

function genPassword(){ return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 4); }
function adminIds(data){ const s = new Set(data.admins.map(a => a.id)); if(data.ownerId) s.add(data.ownerId); return [...s]; }

module.exports = async (req, res) => {
  // Vercel Cron ajoute cet en-tête automatiquement quand CRON_SECRET est configuré,
  // ce qui évite que n'importe qui déclenche cette route depuis l'extérieur.
  if(process.env.CRON_SECRET && req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`){
    res.status(401).send('Non autorisé');
    return;
  }

  const data = await loadData();
  const now = Date.now();

  for(const [username, account] of Object.entries(data.accounts)){
    if(account.plan === 'free') continue;
    if(account.status !== 'active') continue;
    if(!account.expiresAt) continue;
    if(new Date(account.expiresAt).getTime() > now) continue;

    account.password = genPassword();
    account.status = 'expired';

    await bot.sendMessage(account.telegramId, "Ton abonnement Kaisse est arrivé à expiration. Ton accès est suspendu en attendant le renouvellement.").catch(()=>{});

    for(const adminId of adminIds(data)){
      await bot.sendMessage(adminId,
        `Abonnement expiré : ${account.displayName} (@${username}) — ${PLAN_LABELS[account.plan]}.\nRenouveler pour un mois de plus ?`,
        { reply_markup: { inline_keyboard: [[
          { text: '✅ Oui, renouveler', callback_data: `renew:yes:${username}` },
          { text: '❌ Non', callback_data: `renew:no:${username}` }
        ]] } }
      ).catch(()=>{});
    }
  }

  await saveData(data);
  res.status(200).send('OK');
};
