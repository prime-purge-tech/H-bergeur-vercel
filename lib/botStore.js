// lib/botStore.js — remplace l'ancien store.js basé sur un fichier data.json.
// Sur Vercel, le système de fichiers des fonctions serverless est éphémère
// (et souvent en lecture seule), donc on utilise Vercel KV (Redis) à la place.
// Même forme de données qu'avant : { ownerId, admins, accounts, pendingRequests }

const { kv } = require('@vercel/kv');

const KEY = 'kaisse_bot_data';
const REG_PREFIX = 'kaisse_reg_'; // état d'inscription en cours, par chatId

function defaultData() {
  return {
    ownerId: null,       // ID Telegram numérique du propriétaire
    admins: [],          // [{ id, name }]
    accounts: {},        // username -> { telegramId, displayName, password, plan, status, expiresAt }
    pendingRequests: {}  // requestId -> { username, displayName, telegramId }
  };
}

async function load() {
  const data = await kv.get(KEY);
  return data || defaultData();
}

async function save(data) {
  await kv.set(KEY, data);
}

// État d'inscription en cours (remplace le Map en mémoire de l'ancien bot,
// qui ne peut pas survivre entre deux invocations serverless).
async function getRegState(chatId) {
  return (await kv.get(REG_PREFIX + chatId)) || null;
}
async function setRegState(chatId, state) {
  // expire après 30 min d'inactivité pour ne pas laisser traîner des inscriptions abandonnées
  await kv.set(REG_PREFIX + chatId, state, { ex: 1800 });
}
async function clearRegState(chatId) {
  await kv.del(REG_PREFIX + chatId);
}

module.exports = { load, save, getRegState, setRegState, clearRegState };
