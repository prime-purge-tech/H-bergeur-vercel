// bot.js — Bot Telegram de gestion des comptes et abonnements Kaisse
//
// Ce que fait ce bot :
// 1. Quelqu'un tape /start -> le bot lui demande un nom d'utilisateur puis son prenom,
//    et transmet la demande a l'admin (toi) avec Oui / Non.
// 2. Si tu appuies "Non" -> la demande est refusee, la personne est prevenue.
// 3. Si tu appuies "Oui" -> le bot t'envoie 4 boutons pour choisir la formule :
//    Acces gratuit / 1 000 FCFA / 2 500 FCFA / 5 000 FCFA.
// 4. Des que tu choisis une formule, un compte est cree (identifiant + mot de passe
//    genere), et la personne recoit un message avec une photo + un bouton pour
//    ouvrir le site.
// 5. Chaque heure, le bot verifie les abonnements payants expires : il change le
//    mot de passe (donc la personne ne peut plus se connecter) et te redemande
//    Oui / Non pour renouveler.
// 6. Commandes admin : /addadmin, /removeadmin, /transferownership, /listadmins,
//    /pending, /status.
//
// IMPORTANT : ce bot ne fonctionne PAS tout seul avec le fichier Kaisse.html actuel.
// Le site devra un jour verifier les identifiants aupres de ce meme stockage
// (via une petite API) au lieu de son window.storage actuel. C'est une etape a part.

const TelegramBot = require('node-telegram-bot-api');
const { load, save } = require('./store');

const TOKEN = process.env.BOT_TOKEN;
const INITIAL_OWNER_ID = process.env.OWNER_ID ? Number(process.env.OWNER_ID) : null;
const SITE_URL = process.env.SITE_URL || 'https://example.com';
const WELCOME_PHOTO_URL = process.env.WELCOME_PHOTO_URL || 'https://files.catbox.moe/0a019z.jpg';

if(!TOKEN){
  console.error('Erreur : la variable d\'environnement BOT_TOKEN est manquante.');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// ---------- Etat en memoire pour les conversations d'inscription en cours ----------
// chatId -> { step: 'username' | 'displayname', username?, displayName? }
const registrationState = new Map();

// ---------- Initialisation des donnees ----------
let data = load();
if(!data.ownerId && INITIAL_OWNER_ID){
  data.ownerId = INITIAL_OWNER_ID;
  save(data);
  console.log(`Proprietaire initial defini : ${INITIAL_OWNER_ID}`);
}

function persist(){ save(data); }

function isOwner(id){ return data.ownerId === id; }
function isAdmin(id){ return isOwner(id) || data.admins.some(a => a.id === id); }
function adminIds(){
  const ids = new Set(data.admins.map(a => a.id));
  if(data.ownerId) ids.add(data.ownerId);
  return [...ids];
}
function notifyAdmins(text, opts){
  adminIds().forEach(id => bot.sendMessage(id, text, opts).catch(()=>{}));
}

function genPassword(){
  return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 4);
}
function genRequestId(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const PLAN_LABELS = {
  free: 'Acces gratuit',
  decouverte: 'Decouverte (1 000 FCFA/mois)',
  pro: 'Pro (2 500 FCFA/mois)',
  business: 'Business (5 000 FCFA/mois)'
};
const PLAN_PRICE_FCFA = { free: 0, decouverte: 1000, pro: 2500, business: 5000 };

// =====================================================================
// /start — demande de compte
// =====================================================================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const existing = Object.values(data.accounts).find(a => a.telegramId === chatId);
  if(existing){
    bot.sendMessage(chatId, `Tu as deja un compte : *${existing.displayName}* (@${Object.keys(data.accounts).find(u=>data.accounts[u]===existing)}).\nStatut : ${existing.status}${existing.plan ? ' — ' + PLAN_LABELS[existing.plan] : ''}`, { parse_mode: 'Markdown' });
    return;
  }
  registrationState.set(chatId, { step: 'username' });
  bot.sendMessage(chatId, "Bienvenue sur Kaisse !\nChoisis un nom d'utilisateur (sans espace) :");
});

bot.on('message', (msg) => {
  if(!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const state = registrationState.get(chatId);
  if(!state) return;

  if(state.step === 'username'){
    const username = msg.text.trim().toLowerCase().replace(/\s+/g, '');
    if(!username || data.accounts[username] || Object.values(data.pendingRequests).some(r => r.username === username)){
      bot.sendMessage(chatId, "Ce nom d'utilisateur est deja pris ou invalide. Essaie un autre nom :");
      return;
    }
    state.username = username;
    state.step = 'displayname';
    bot.sendMessage(chatId, 'Et ton prenom (ce qui apparaitra sur les ventes) ?');
    return;
  }

  if(state.step === 'displayname'){
    const displayName = msg.text.trim();
    if(!displayName){ bot.sendMessage(chatId, 'Indique ton prenom :'); return; }

    const requestId = genRequestId();
    data.pendingRequests[requestId] = { username: state.username, displayName, telegramId: chatId };
    persist();
    registrationState.delete(chatId);

    bot.sendMessage(chatId, "Ta demande a ete envoyee au proprietaire. Tu recevras un message des qu'elle sera traitee.");

    notifyAdmins(
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
  const data_ = query.data || '';
  const [kind, action, refId] = data_.split(':');

  try{

    // ---- Etape 1 : accepter / refuser une demande ----
    if(kind === 'req'){
      if(!isAdmin(from)){ await bot.answerCallbackQuery(query.id, { text: 'Reserve aux admins' }); return; }
      const request = data.pendingRequests[refId];
      if(!request){ await bot.answerCallbackQuery(query.id, { text: 'Demande introuvable ou deja traitee' }); return; }

      if(action === 'refuse'){
        delete data.pendingRequests[refId];
        persist();
        bot.sendMessage(request.telegramId, "Ta demande de compte a ete refusee.");
        await bot.editMessageText(`Demande de ${request.displayName} (@${request.username}) : refusee.`, {
          chat_id: query.message.chat.id, message_id: query.message.message_id
        });
        await bot.answerCallbackQuery(query.id, { text: 'Refusee' });
        return;
      }

      if(action === 'accept'){
        await bot.editMessageText(`Demande de ${request.displayName} (@${request.username}) acceptee. Choisis la formule :`, {
          chat_id: query.message.chat.id, message_id: query.message.message_id
        });
        bot.sendMessage(query.message.chat.id, 'Choisis la formule pour ce compte :', {
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
    if(kind === 'plan'){
      if(!isAdmin(from)){ await bot.answerCallbackQuery(query.id, { text: 'Reserve aux admins' }); return; }
      const request = data.pendingRequests[refId];
      if(!request){ await bot.answerCallbackQuery(query.id, { text: 'Demande introuvable ou deja traitee' }); return; }

      const plan = action; // free | decouverte | pro | business
      const password = genPassword();
      const isFree = plan === 'free';
      const expiresAt = isFree ? null : new Date(Date.now() + 30*24*60*60*1000).toISOString();

      data.accounts[request.username] = {
        telegramId: request.telegramId,
        displayName: request.displayName,
        password,
        plan,
        status: 'active',
        expiresAt
      };
      delete data.pendingRequests[refId];
      persist();

      await bot.editMessageText(`Compte de ${request.displayName} (@${request.username}) cree — ${PLAN_LABELS[plan]}.`, {
        chat_id: query.message.chat.id, message_id: query.message.message_id
      });
      await bot.answerCallbackQuery(query.id, { text: 'Compte cree' });

      const caption = `Bienvenue ${request.displayName} !\n\nTon compte Kaisse est pret.\nIdentifiant : ${request.username}\nMot de passe : ${password}\nFormule : ${PLAN_LABELS[plan]}${expiresAt ? '\nValable jusqu\'au : ' + new Date(expiresAt).toLocaleDateString('fr-FR') : ''}`;
      try{
        await bot.sendPhoto(request.telegramId, WELCOME_PHOTO_URL, {
          caption,
          reply_markup: { inline_keyboard: [[{ text: 'Ouvrir le site', url: SITE_URL }]] }
        });
      }catch(e){
        // si la photo echoue, on envoie au moins le texte avec le bouton
        await bot.sendMessage(request.telegramId, caption, {
          reply_markup: { inline_keyboard: [[{ text: 'Ouvrir le site', url: SITE_URL }]] }
        });
      }
      return;
    }

    // ---- Renouvellement d'un abonnement expire ----
    if(kind === 'renew'){
      if(!isAdmin(from)){ await bot.answerCallbackQuery(query.id, { text: 'Reserve aux admins' }); return; }
      const username = refId;
      const account = data.accounts[username];
      if(!account){ await bot.answerCallbackQuery(query.id, { text: 'Compte introuvable' }); return; }

      if(action === 'no'){
        await bot.editMessageText(`${account.displayName} (@${username}) : abonnement non renouvele. Compte toujours bloque.`, {
          chat_id: query.message.chat.id, message_id: query.message.message_id
        });
        bot.sendMessage(account.telegramId, "Ton abonnement n'a pas ete renouvele. Contacte le proprietaire pour te reabonner.").catch(()=>{});
        await bot.answerCallbackQuery(query.id, { text: 'Non renouvele' });
        return;
      }

      if(action === 'yes'){
        const newPassword = genPassword();
        account.password = newPassword;
        account.status = 'active';
        account.expiresAt = new Date(Date.now() + 30*24*60*60*1000).toISOString();
        persist();

        await bot.editMessageText(`${account.displayName} (@${username}) : abonnement renouvele jusqu'au ${new Date(account.expiresAt).toLocaleDateString('fr-FR')}.`, {
          chat_id: query.message.chat.id, message_id: query.message.message_id
        });
        bot.sendMessage(account.telegramId,
          `Ton abonnement a ete renouvele !\nNouveau mot de passe : ${newPassword}\nValable jusqu'au ${new Date(account.expiresAt).toLocaleDateString('fr-FR')}.`,
          { reply_markup: { inline_keyboard: [[{ text: 'Ouvrir le site', url: SITE_URL }]] } }
        ).catch(()=>{});
        await bot.answerCallbackQuery(query.id, { text: 'Renouvele' });
        return;
      }
    }

  }catch(err){
    console.error('Erreur callback_query :', err);
    try{ await bot.answerCallbackQuery(query.id, { text: 'Erreur, reessaie' }); }catch(e){}
  }
});

// =====================================================================
// Verification horaire des abonnements expires
// =====================================================================
function checkExpirations(){
  const now = Date.now();
  Object.entries(data.accounts).forEach(([username, account]) => {
    if(account.plan === 'free') return;
    if(account.status !== 'active') return;
    if(!account.expiresAt) return;
    if(new Date(account.expiresAt).getTime() > now) return;

    // Abonnement expire : on change le mot de passe et on bloque l'acces
    account.password = genPassword();
    account.status = 'expired';
    persist();

    bot.sendMessage(account.telegramId, "Ton abonnement Kaisse est arrive a expiration. Ton acces est suspendu en attendant le renouvellement.").catch(()=>{});

    notifyAdmins(
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
  });
}
setInterval(checkExpirations, 60 * 60 * 1000); // toutes les heures

// =====================================================================
// Commandes admin
// =====================================================================
bot.onText(/\/addadmin (\d+) (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if(!isAdmin(chatId)){ bot.sendMessage(chatId, "Reserve aux admins."); return; }
  const newId = Number(match[1]);
  const name = match[2].trim();
  if(data.admins.some(a => a.id === newId) || data.ownerId === newId){
    bot.sendMessage(chatId, 'Cette personne est deja admin ou proprietaire.'); return;
  }
  data.admins.push({ id: newId, name });
  persist();
  bot.sendMessage(chatId, `${name} a ete ajoute comme admin.`);
  bot.sendMessage(newId, "Tu as ete ajoute comme admin du bot Kaisse.").catch(()=>{});
});

bot.onText(/\/removeadmin (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if(!isOwner(chatId)){ bot.sendMessage(chatId, "Reserve au proprietaire."); return; }
  const targetId = Number(match[1]);
  data.admins = data.admins.filter(a => a.id !== targetId);
  persist();
  bot.sendMessage(chatId, 'Admin retire.');
});

bot.onText(/\/transferownership (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if(!isOwner(chatId)){ bot.sendMessage(chatId, "Reserve au proprietaire actuel."); return; }
  const newOwnerId = Number(match[1]);
  const oldOwnerId = data.ownerId;
  data.ownerId = newOwnerId;
  if(!data.admins.some(a => a.id === oldOwnerId)){
    data.admins.push({ id: oldOwnerId, name: 'Ancien proprietaire' });
  }
  data.admins = data.admins.filter(a => a.id !== newOwnerId);
  persist();
  bot.sendMessage(chatId, 'Propriete transferee. Tu restes admin.');
  bot.sendMessage(newOwnerId, "Tu es maintenant le proprietaire du bot Kaisse.").catch(()=>{});
});

bot.onText(/\/listadmins/, (msg) => {
  const chatId = msg.chat.id;
  if(!isAdmin(chatId)){ bot.sendMessage(chatId, "Reserve aux admins."); return; }
  const lines = [`Proprietaire : ${data.ownerId}`, ...data.admins.map(a => `Admin : ${a.name} (${a.id})`)];
  bot.sendMessage(chatId, lines.join('\n'));
});

bot.onText(/\/pending/, (msg) => {
  const chatId = msg.chat.id;
  if(!isAdmin(chatId)){ bot.sendMessage(chatId, "Reserve aux admins."); return; }
  const entries = Object.entries(data.pendingRequests);
  if(entries.length === 0){ bot.sendMessage(chatId, 'Aucune demande en attente.'); return; }
  entries.forEach(([reqId, r]) => {
    bot.sendMessage(chatId, `${r.displayName} (@${r.username})`, {
      reply_markup: { inline_keyboard: [[
        { text: '✅ Oui', callback_data: `req:accept:${reqId}` },
        { text: '❌ Non', callback_data: `req:refuse:${reqId}` }
      ]] }
    });
  });
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const entry = Object.entries(data.accounts).find(([, a]) => a.telegramId === chatId);
  if(!entry){ bot.sendMessage(chatId, "Tu n'as pas de compte. Tape /start pour en demander un."); return; }
  const [username, account] = entry;
  const expiry = account.expiresAt ? new Date(account.expiresAt).toLocaleDateString('fr-FR') : 'illimite';
  bot.sendMessage(chatId, `Compte : @${username}\nFormule : ${PLAN_LABELS[account.plan]}\nStatut : ${account.status}\nExpire le : ${expiry}`);
});

console.log('Bot Kaisse demarre.');
