// lib/kv.js — stockage persistant via Vercel KV (gratuit, lié à ton projet Vercel).
// Remplace l'ancien store.js basé sur un fichier JSON, qui ne peut pas fonctionner
// dans une fonction serverless (pas de disque persistant entre les requêtes).

const { kv } = require('@vercel/kv');

const DATA_KEY = 'kaisse:data';

function defaultData(){
  return {
    ownerId: null,
    admins: [],
    accounts: {},
    pendingRequests: {}
  };
}

async function loadData(){
  const data = await kv.get(DATA_KEY);
  return data || defaultData();
}

async function saveData(data){
  await kv.set(DATA_KEY, data);
}

// État de la conversation d'inscription en cours (par personne), avec expiration
// automatique au bout de 15 minutes pour ne pas laisser de demandes à moitié faites.
async function getRegistrationState(chatId){
  return await kv.get(`reg:${chatId}`);
}
async function setRegistrationState(chatId, state){
  await kv.set(`reg:${chatId}`, state, { ex: 900 });
}
async function clearRegistrationState(chatId){
  await kv.del(`reg:${chatId}`);
}

module.exports = { loadData, saveData, getRegistrationState, setRegistrationState, clearRegistrationState, defaultData };
