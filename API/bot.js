// api/bot.js — reçoit chaque message/clic Telegram via webhook (Vercel appelle
// cette fonction à chaque fois, pas besoin de laisser un processus tourner).

const TelegramBot = require('node-telegram-bot-api');
const { loadData, saveData, getRegistrationState, setRegistrationState, clearRegistrationState } = require('../lib/kv');

const TOKEN = process.env.BOT_TOKEN;
const SITE_URL = process.env.SITE_URL || 'https://example.com';
const WELCOME_PHOTO_URL = process.env.WELCOME_PHOTO_URL || 'https://files.catbox.moe/0a019z.jpg';
const INITIAL_OWNER_ID = process.env.OWNER_ID ? Number(process.env.OWNER_ID) : null;

const bot = new TelegramBot(TOKEN); // pas de polling : on répond nous-mêmes à chaque webhook

const PLAN_LABELS = {
  free: 'Accès gratuit',
  decouverte: 'Découverte (1 000 FCFA/mois)',
  pro: 'Pro (2 500 FCFA/mois)',
  business: 'Business (5 000 FCFA/mois)'
};

function genPassword(){ return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 4); }
function genRequestId(){ return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function isOwner(data, id){ return data.ownerId === id; }
function isAdmin(data, id){ return isOwner(data, id) || data.admins.some(a => a.id === id); }
function adminIds(data){ const s = new Set(data.admins.map(a => a.id)); if(data.ownerId) s.add(data.ownerId); return [...s]; }
async function notifyAdmins(data, text, opts){
  for(const id of adminIds(data)){
    try{ await bot.sendMessage(id, text, opts); }catch(e){}
  }
}

module.exports = async (req, res) => {
  if(req.method !== 'POST'){
    res.status(200).send('Kaisse bot webhook actif');
    return;
  }

  try{
    const update = req.body;
    const data = await loadData();
    if(!data.ownerId && INITIAL_OWNER_ID) data.ownerId = INITIAL_OWNER_ID;

    if(update.message) await handleMessage(update.message, data);
    else if(update.callback_query) await handleCallback(update.callback_query, data);

    await saveData(data);
  }catch(err){
    console.error('Erreur webhook Kaisse :', err);
  }
  res.status(200).send('OK');
};

async function handleMessage(msg, data){
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if(text.startsWith('/start')){
    const existing = Object.entries(data.accounts).find(([, a]) => a.telegramId === chatId);
    if(existing){
      const [username, account] = existing;
      await bot.sendMessage(chatId, `Tu as déjà un compte : ${account.displayName} (@${username}).\nStatut : ${account.status}${account.plan ? ' — ' + PLAN_LABELS[account.plan] : ''}`);
      return;
    }
    await setRegistrationState(chatId, { step: 'username' });
    await bot.sendMessage(chatId, "Bienvenue sur Kaisse !\nChoisis un nom d'utilisateur (sans espace) :");
    return;
  }

  if(text.startsWith('/status')){
    const entry = Object.entries(data.accounts).find(([, a]) => a.telegramId === chatId);
    if(!entry){ await bot.sendMessage(chatId, "Tu n'as pas de compte. Tape /start pour en demander un."); return; }
    const [username, account] = entry;
    const expiry = account.expiresAt ? new Date(account.expiresAt).toLocaleDateString('fr-FR') : 'illimité';
    await bot.sendMessage(chatId, `Compte : @${username}\nFormule : ${PLAN_LABELS[account.plan]}\nStatut : ${account.status}\nExpire le : ${expiry}`);
    return;
  }

  const addAdminMatch = text.match(/^\/addadmin (\d+) (.+)/);
  if(addAdminMatch){
    if(!isAdmin(data, chatId)){ await bot.sendMessage(chatId, 'Réservé aux admins.'); return; }
    const newId = Number(addAdminMatch[1]);
    const name = addAdminMatch[2].trim();
    if(data.admins.some(a => a.id === newId) || data.ownerId === newId){ await bot.sendMessage(chatId, 'Déjà admin ou propriétaire.'); return; }
    data.admins.push({ id: newId, name });
    await bot.sendMessage(chatId, `${name} ajouté comme admin.`);
    await bot.sendMessage(newId, 'Tu as été ajouté comme admin du bot Kaisse.').catch(()=>{});
    return;
  }

  const removeAdminMatch = text.match(/^\/removeadmin (\d+)/);
  if(removeAdminMatch){
    if(!isOwner(data, chatId)){ await bot.sendMessage(chatId, 'Réservé au propriétaire.'); return; }
    data.admins = data.admins.filter(a => a.id !== Number(removeAdminMatch[1]));
    await bot.sendMessage(chatId, 'Admin retiré.');
    return;
  }

  const transferMatch = text.match(/^\/transferownership (\d+)/);
  if(transferMatch){
    if(!isOwner(data, chatId)){ await bot.sendMessage(chatId, 'Réservé au propriétaire actuel.'); return; }
    const newOwnerId = Number(transferMatch[1]);
    const oldOwnerId = data.ownerId;
    data.ownerId = newOwnerId;
    if(!data.admins.some(a => a.id === oldOwnerId)) data.admins.push({ id: oldOwnerId, name: 'Ancien propriétaire' });
    data.admins = data.admins.filter(a => a.id !== newOwnerId);
    await bot.sendMessage(chatId, 'Propriété transférée. Tu restes admin.');
    await bot.sendMessage(newOwnerId, 'Tu es maintenant le propriétaire du bot Kaisse.').catch(()=>{});
    return;
  }

  if(text.startsWith('/listadmins')){
    if(!isAdmin(data, chatId)){ await bot.sendMessage(chatId, 'Réservé aux admins.'); return; }
    const lines = [`Propriétaire : ${data.ownerId}`, ...data.admins.map(a => `Admin : ${a.name} (${a.id})`)];
    await bot.sendMessage(chatId, lines.join('\n'));
    return;
  }

  if(text.startsWith('/pending')){
    if(!isAdmin(data, chatId)){ await bot.sendMessage(chatId, 'Réservé aux admins.'); return; }
    const entries = Object.entries(data.pendingRequests);
    if(entries.length === 0){ await bot.sendMessage(chatId, 'Aucune demande en attente.'); return; }
    for(const [reqId, r] of entries){
      await bot.sendMessage(chatId, `${r.displayName} (@${r.username})`, {
        reply_markup: { inline_keyboard: [[
          { text: '✅ Oui', callback_data: `req:accept:${reqId}` },
          { text: '❌ Non', callback_data: `req:refuse:${reqId}` }
        ]] }
      });
    }
    return;
  }

  if(text.startsWith('/')) return;

  // Suite de l'inscription en cours (username -> prénom)
  const state = await getRegistrationState(chatId);
  if(!state) return;

  if(state.step === 'username'){
    const username = text.toLowerCase().replace(/\s+/g, '');
    const taken = data.accounts[username] || Object.values(data.pendingRequests).some(r => r.username === username);
    if(!username || taken){
      await bot.sendMessage(chatId, "Ce nom d'utilisateur est déjà pris ou invalide. Essaie un autre nom :");
      return;
    }
    await setRegistrationState(chatId, { step: 'displayname', username });
    await bot.sendMessage(chatId, 'Et ton prénom (ce qui apparaîtra sur les ventes) ?');
    return;
  }

  if(state.step === 'displayname'){
    const displayName = text;
    if(!displayName){ await bot.sendMessage(chatId, 'Indique ton prénom :'); return; }
    const requestId = genRequestId();
    data.pendingRequests[requestId] = { username: state.username, displayName, telegramId: chatId };
    await clearRegistrationState(chatId);
    await bot.sendMessage(chatId, "Ta demande a été envoyée au propriétaire. Tu recevras un message dès qu'elle sera traitée.");
    await notifyAdmins(data, `Nouvelle demande de compte :\n${displayName} (@${state.username})\n\nAccepter ?`, {
      reply_markup: { inline_keyboard: [[
        { text: '✅ Oui', callback_data: `req:accept:${requestId}` },
        { text: '❌ Non', callback_data: `req:refuse:${requestId}` }
      ]] }
    });
    return;
  }
}

async function handleCallback(query, data){
  const from = query.from.id;
  const [kind, action, refId] = (query.data || '').split(':');

  try{
    if(kind === 'req'){
      if(!isAdmin(data, from)){ await bot.answerCallbackQuery(query.id, { text: 'Réservé aux admins' }); return; }
      const request = data.pendingRequests[refId];
      if(!request){ await bot.answerCallbackQuery(query.id, { text: 'Demande introuvable ou déjà traitée' }); return; }

      if(action === 'refuse'){
        delete data.pendingRequests[refId];
        await bot.sendMessage(request.telegramId, 'Ta demande de compte a été refusée.').catch(()=>{});
        await bot.editMessageText(`Demande de ${request.displayName} (@${request.username}) : refusée.`, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(()=>{});
        await bot.answerCallbackQuery(query.id, { text: 'Refusée' });
        return;
      }
      if(action === 'accept'){
        await bot.editMessageText(`Demande de ${request.displayName} (@${request.username}) acceptée. Choisis la formule :`, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(()=>{});
        await bot.sendMessage(query.message.chat.id, 'Choisis la formule pour ce compte :', {
          reply_markup: { inline_keyboard: [
            [{ text: '🔓 Accès gratuit', callback_data: `plan:free:${refId}` }],
            [{ text: '🟢 1 000 FCFA/mois', callback_data: `plan:decouverte:${refId}` }],
            [{ text: '🔵 2 500 FCFA/mois', callback_data: `plan:pro:${refId}` }],
            [{ text: '🟡 5 000 FCFA/mois', callback_data: `plan:business:${refId}` }]
          ] }
        });
        await bot.answerCallbackQuery(query.id);
        return;
      }
    }

    if(kind === 'plan'){
      if(!isAdmin(data, from)){ await bot.answerCallbackQuery(query.id, { text: 'Réservé aux admins' }); return; }
      const request = data.pendingRequests[refId];
      if(!request){ await bot.answerCallbackQuery(query.id, { text: 'Demande introuvable ou déjà traitée' }); return; }

      const plan = action;
      const password = genPassword();
      const expiresAt = plan === 'free' ? null : new Date(Date.now() + 30*24*60*60*1000).toISOString();

      data.accounts[request.username] = { telegramId: request.telegramId, displayName: request.displayName, password, plan, status: 'active', expiresAt };
      delete data.pendingRequests[refId];

      await bot.editMessageText(`Compte de ${request.displayName} (@${request.username}) créé — ${PLAN_LABELS[plan]}.`, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(()=>{});
      await bot.answerCallbackQuery(query.id, { text: 'Compte créé' });

      const caption = `Bienvenue ${request.displayName} !\n\nTon compte Kaisse est prêt.\nIdentifiant : ${request.username}\nMot de passe : ${password}\nFormule : ${PLAN_LABELS[plan]}${expiresAt ? '\nValable jusqu\'au : ' + new Date(expiresAt).toLocaleDateString('fr-FR') : ''}`;
      try{
        await bot.sendPhoto(request.telegramId, WELCOME_PHOTO_URL, { caption, reply_markup: { inline_keyboard: [[{ text: 'Ouvrir le site', url: SITE_URL }]] } });
      }catch(e){
        await bot.sendMessage(request.telegramId, caption, { reply_markup: { inline_keyboard: [[{ text: 'Ouvrir le site', url: SITE_URL }]] } });
      }
      return;
    }

    if(kind === 'renew'){
      if(!isAdmin(data, from)){ await bot.answerCallbackQuery(query.id, { text: 'Réservé aux admins' }); return; }
      const username = refId;
      const account = data.accounts[username];
      if(!account){ await bot.answerCallbackQuery(query.id, { text: 'Compte introuvable' }); return; }

      if(action === 'no'){
        await bot.editMessageText(`${account.displayName} (@${username}) : abonnement non renouvelé.`, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(()=>{});
        await bot.sendMessage(account.telegramId, "Ton abonnement n'a pas été renouvelé. Contacte le propriétaire pour te réabonner.").catch(()=>{});
        await bot.answerCallbackQuery(query.id, { text: 'Non renouvelé' });
        return;
      }
      if(action === 'yes'){
        const newPassword = genPassword();
        account.password = newPassword;
        account.status = 'active';
        account.expiresAt = new Date(Date.now() + 30*24*60*60*1000).toISOString();
        await bot.editMessageText(`${account.displayName} (@${username}) : abonnement renouvelé jusqu'au ${new Date(account.expiresAt).toLocaleDateString('fr-FR')}.`, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(()=>{});
        await bot.sendMessage(account.telegramId, `Ton abonnement a été renouvelé !\nNouveau mot de passe : ${newPassword}\nValable jusqu'au ${new Date(account.expiresAt).toLocaleDateString('fr-FR')}.`, { reply_markup: { inline_keyboard: [[{ text: 'Ouvrir le site', url: SITE_URL }]] } }).catch(()=>{});
        await bot.answerCallbackQuery(query.id, { text: 'Renouvelé' });
        return;
      }
    }
  }catch(err){
    console.error('Erreur callback Kaisse :', err);
    try{ await bot.answerCallbackQuery(query.id, { text: 'Erreur, réessaie' }); }catch(e){}
  }
}
