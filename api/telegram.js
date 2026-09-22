// api/telegram.js — bot Telegram Kaisse, en mode WEBHOOK (pas de polling).
// Sur Vercel, une fonction serverless ne tourne pas en continu : Telegram
// nous envoie chaque update en POST sur cette URL au lieu qu'on aille les chercher.
// Toute la logique de bot.js est reprise à l'identique (mêmes commandes,
// mêmes boutons), seul le stockage change (Vercel KV au lieu d'un fichier
// et d'un Map en mémoire — voir lib/botStore.js).

const TelegramBot = require('node-telegram-bot-api');
const store = require('../lib/botStore');

const TOKEN = process.env.BOT_TOKEN;
const SITE_URL = process.env.SITE_URL || 'https://example.com';
const WELCOME_PHOTO_URL = process.env.WELCOME_PHOTO_URL || 'https://files.catbox.moe/0a019z.jpg';
const INITIAL_OWNER_ID = process.env.OWNER_ID ? Number(process.env.OWNER_ID) : null;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

// polling:false — on ne fait QUE traiter les updates reçues via processUpdate()
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
function genRequestId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function isOwner(data, id) { return data.ownerId === id; }
function isAdmin(data, id) { return isOwner(data, id) || data.admins.some(a => a.id === id); }
function adminIds(data) {
  const ids = new Set(data.admins.map(a => a.id));
  if (data.ownerId) ids.add(data.ownerId);
  return [...ids];
}
async function notifyAdmins(data, text, opts) {
  await Promise.all(adminIds(data).map(id => bot.sendMessage(id, text, opts).catch(() => {})));
}

async function ensureOwner(data) {
  if (!data.ownerId && INITIAL_OWNER_ID) {
    data.ownerId = INITIAL_OWNER_ID;
    await store.save(data);
  }
  return data;
}

// =====================================================================
// /start — demande de compte
// =====================================================================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  let data = await store.load();
  data = await ensureOwner(data);

  const existing = Object.values(data.accounts).find(a => a.telegramId === chatId);
  if (existing) {
    const username = Object.keys(data.accounts).find(u => data.accounts[u] === existing);
    await bot.sendMessage(chatId, `Tu as deja un compte : *${existing.displayName}* (@${username}).\nStatut : ${existing.status}${existing.plan ? ' — ' + PLAN_LABELS[existing.plan] : ''}`, { parse_mode: 'Markdown' });
    return;
  }
  await store.setRegState(chatId, { step: 'username' });
  await bot.sendMessage(chatId, "Bienvenue sur Kaisse !\nChoisis un nom d'utilisateur (sans espace) :");
});

// ---------- Suite de l'inscription (texte libre) ----------
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const state = await store.getRegState(chatId);
  if (!state) return;
  const data = await store.load();

  if (state.step === 'username') {
    const username = msg.text.trim().toLowerCase().replace(/\s+/g, '');
    if (!username || data.accounts[username] || Object.values(data.pendingRequests).some(r => r.username === username)) {
      await bot.sendMessage(chatId, "Ce nom d'utilisateur est deja pris ou invalide. Essaie un autre nom :");
      return;
    }
    state.username = username;
    state.step = 'displayname';
    await store.setRegState(chatId, state);
    await bot.sendMessage(chatId, 'Et ton prenom (ce qui apparaitra sur les ventes) ?');
    return;
  }

  if (state.step === 'displayname') {
    const displayName = msg.text.trim();
    if (!displayName) { await bot.sendMessage(chatId, 'Indique ton prenom :'); return; }

    const requestId = genRequestId();
    data.pendingRequests[requestId] = { username: state.username, displayName, telegramId: chatId };
    await store.save(data);
    await store.clearRegState(chatId);

    await bot.sendMessage(chatId, "Ta demande a ete envoyee au proprietaire. Tu recevras un message des qu'elle sera traitee.");

    await notifyAdmins(
      data,
      `Nouvelle demande de compte :\n*${displayName}* (@${state.username})\n\nAccepter ?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Oui', callback_data: `req:accept:${requestId}` },
            { text: '❌ Non', callback_data: `req:refuse:${requestId}` }
          ]]
        }
      }
    );
  }
});

// =====================================================================
// Boutons (callback_query)
// =====================================================================
bot.on('callback_query', async (query) => {
  const from = query.from.id;
  const [kind, action, refId] = (query.data || '').split(':');
  const data = await store.load();

  try {
    // ---- Etape 1 : accepter / refuser une demande ----
    if (kind === 'req') {
      if (!isAdmin(data, from)) { await bot.answerCallbackQuery(query.id, { text: 'Reserve aux admins' }); return; }
      const request = data.pendingRequests[refId];
      if (!request) { await bot.answerCallbackQuery(query.id, { text: 'Demande introuvable ou deja traitee' }); return; }

      if (action === 'refuse') {
        delete data.pendingRequests[refId];
        await store.save(data);
        await bot.sendMessage(request.telegramId, "Ta demande de compte a ete refusee.");
        await bot.editMessageText(`Demande de ${request.displayName} (@${request.username}) : refusee.`, {
          chat_id: query.message.chat.id, message_id: query.message.message_id
        });
        await bot.answerCallbackQuery(query.id, { text: 'Refusee' });
        return;
      }

      if (action === 'accept') {
        await bot.editMessageText(`Demande de ${request.displayName} (@${request.username}) acceptee. Choisis la formule :`, {
          chat_id: query.message.chat.id, message_id: query.message.message_id
        });
        await bot.sendMessage(query.message.chat.id, 'Choisis la formule pour ce compte :', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔓 Acces gratuit', callback_data: `plan:free:${refId}` }],
              [{ text: '🟢 1 000 FCFA/mois', callback_data: `plan:decouverte:${refId}` }],
              [{ text: '🔵 2 500 FCFA/mois', callback_data: `plan:pro:${refId}` }],
              [{ text: '🟡 5 000 FCFA/mois', callback_data: `plan:business:${refId}` }]
            ]
          }
        });
        await bot.answerCallbackQuery(query.id);
        return;
      }
    }

    // ---- Etape 2 : choix de la formule -> creation du compte ----
    if (kind === 'plan') {
      if (!isAdmin(data, from)) { await bot.answerCallbackQuery(query.id, { text: 'Reserve aux admins' }); return; }
      const request = data.pendingRequests[refId];
      if (!request) { await bot.answerCallbackQuery(query.id, { text: 'Demande introuvable ou deja traitee' }); return; }

      const plan = action;
      const password = genPassword();
      const isFree = plan === 'free';
      const expiresAt = isFree ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      data.accounts[request.username] = {
        telegramId: request.telegramId,
        displayName: request.displayName,
        password,
        plan,
        status: 'active',
        expiresAt
      };
      delete data.pendingRequests[refId];
      await store.save(data);

      await bot.editMessageText(`Compte de ${request.displayName} (@${request.username}) cree — ${PLAN_LABELS[plan]}.`, {
        chat_id: query.message.chat.id, message_id: query.message.message_id
      });
      await bot.answerCallbackQuery(query.id, { text: 'Compte cree' });

      const caption = `Bienvenue ${request.displayName} !\n\nTon compte Kaisse est pret.\nIdentifiant : ${request.username}\nMot de passe : ${password}\nFormule : ${PLAN_LABELS[plan]}${expiresAt ? '\nValable jusqu\'au : ' + new Date(expiresAt).toLocaleDateString('fr-FR') : ''}`;
      try {
        await bot.sendPhoto(request.telegramId, WELCOME_PHOTO_URL, {
          caption,
          reply_markup: { inline_keyboard: [[{ text: 'Ouvrir le site', url: SITE_URL }]] }
        });
      } catch (e) {
        await bot.sendMessage(request.telegramId, caption, {
          reply_markup: { inline_keyboard: [[{ text: 'Ouvrir le site', url: SITE_URL }]] }
        });
      }
      return;
    }

    // ---- Renouvellement d'un abonnement expire ----
    if (kind === 'renew') {
      if (!isAdmin(data, from)) { await bot.answerCallbackQuery(query.id, { text: 'Reserve aux admins' }); return; }
      const username = refId;
      const account = data.accounts[username];
      if (!account) { await bot.answerCallbackQuery(query.id, { text: 'Compte introuvable' }); return; }

      if (action === 'no') {
        await bot.editMessageText(`${account.displayName} (@${username}) : abonnement non renouvele. Compte toujours bloque.`, {
          chat_id: query.message.chat.id, message_id: query.message.message_id
        });
        await bot.sendMessage(account.telegramId, "Ton abonnement n'a pas ete renouvele. Contacte le proprietaire pour te reabonner.").catch(() => {});
        await bot.answerCallbackQuery(query.id, { text: 'Non renouvele' });
        return;
      }

      if (action === 'yes') {
        const newPassword = genPassword();
        account.password = newPassword;
        account.status = 'active';
        account.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        await store.save(data);

        await bot.editMessageText(`${account.displayName} (@${username}) : abonnement renouvele jusqu'au ${new Date(account.expiresAt).toLocaleDateString('fr-FR')}.`, {
          chat_id: query.message.chat.id, message_id: query.message.message_id
        });
        await bot.sendMessage(account.telegramId,
          `Ton abonnement a ete renouvele !\nNouveau mot de passe : ${newPassword}\nValable jusqu'au ${new Date(account.expiresAt).toLocaleDateString('fr-FR')}.`,
          { reply_markup: { inline_keyboard: [[{ text: 'Ouvrir le site', url: SITE_URL }]] } }
        ).catch(() => {});
        await bot.answerCallbackQuery(query.id, { text: 'Renouvele' });
        return;
      }
    }
  } catch (err) {
    console.error('Erreur callback_query :', err);
    try { await bot.answerCallbackQuery(query.id, { text: 'Erreur, reessaie' }); } catch (e) {}
  }
});

// =====================================================================
// Commandes admin
// =====================================================================
bot.onText(/\/addadmin (\d+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const data = await store.load();
  if (!isAdmin(data, chatId)) { await bot.sendMessage(chatId, "Reserve aux admins."); return; }
  const newId = Number(match[1]);
  const name = match[2].trim();
  if (data.admins.some(a => a.id === newId) || data.ownerId === newId) {
    await bot.sendMessage(chatId, 'Cette personne est deja admin ou proprietaire.'); return;
  }
  data.admins.push({ id: newId, name });
  await store.save(data);
  await bot.sendMessage(chatId, `${name} a ete ajoute comme admin.`);
  await bot.sendMessage(newId, "Tu as ete ajoute comme admin du bot Kaisse.").catch(() => {});
});

bot.onText(/\/removeadmin (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const data = await store.load();
  if (!isOwner(data, chatId)) { await bot.sendMessage(chatId, "Reserve au proprietaire."); return; }
  const targetId = Number(match[1]);
  data.admins = data.admins.filter(a => a.id !== targetId);
  await store.save(data);
  await bot.sendMessage(chatId, 'Admin retire.');
});

bot.onText(/\/transferownership (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const data = await store.load();
  if (!isOwner(data, chatId)) { await bot.sendMessage(chatId, "Reserve au proprietaire actuel."); return; }
  const newOwnerId = Number(match[1]);
  const oldOwnerId = data.ownerId;
  data.ownerId = newOwnerId;
  if (!data.admins.some(a => a.id === oldOwnerId)) {
    data.admins.push({ id: oldOwnerId, name: 'Ancien proprietaire' });
  }
  data.admins = data.admins.filter(a => a.id !== newOwnerId);
  await store.save(data);
  await bot.sendMessage(chatId, 'Propriete transferee. Tu restes admin.');
  await bot.sendMessage(newOwnerId, "Tu es maintenant le proprietaire du bot Kaisse.").catch(() => {});
});

bot.onText(/\/listadmins/, async (msg) => {
  const chatId = msg.chat.id;
  const data = await store.load();
  if (!isAdmin(data, chatId)) { await bot.sendMessage(chatId, "Reserve aux admins."); return; }
  const lines = [`Proprietaire : ${data.ownerId}`, ...data.admins.map(a => `Admin : ${a.name} (${a.id})`)];
  await bot.sendMessage(chatId, lines.join('\n'));
});

bot.onText(/\/pending/, async (msg) => {
  const chatId = msg.chat.id;
  const data = await store.load();
  if (!isAdmin(data, chatId)) { await bot.sendMessage(chatId, "Reserve aux admins."); return; }
  const entries = Object.entries(data.pendingRequests);
  if (entries.length === 0) { await bot.sendMessage(chatId, 'Aucune demande en attente.'); return; }
  for (const [reqId, r] of entries) {
    await bot.sendMessage(chatId, `${r.displayName} (@${r.username})`, {
      reply_markup: { inline_keyboard: [[
        { text: '✅ Oui', callback_data: `req:accept:${reqId}` },
        { text: '❌ Non', callback_data: `req:refuse:${reqId}` }
      ]] }
    });
  }
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const data = await store.load();
  const entry = Object.entries(data.accounts).find(([, a]) => a.telegramId === chatId);
  if (!entry) { await bot.sendMessage(chatId, "Tu n'as pas de compte. Tape /start pour en demander un."); return; }
  const [username, account] = entry;
  const expiry = account.expiresAt ? new Date(account.expiresAt).toLocaleDateString('fr-FR') : 'illimite';
  await bot.sendMessage(chatId, `Compte : @${username}\nFormule : ${PLAN_LABELS[account.plan]}\nStatut : ${account.status}\nExpire le : ${expiry}`);
});

// =====================================================================
// Point d'entrée serverless : Telegram POST ici à chaque update
// =====================================================================
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).send('Kaisse bot webhook OK');
    return;
  }
  if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
    res.status(401).send('Unauthorized');
    return;
  }
  try {
    const update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    await bot.processUpdate(update);
  } catch (e) {
    console.error('Erreur traitement update Telegram:', e);
  }
  res.status(200).send('OK');
};
