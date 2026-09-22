// store.js — stockage simple dans un fichier JSON.
// Suffisant pour demarrer ; si le volume grandit beaucoup, migrer vers une vraie base
// (Postgres/Supabase) sans changer l'API de ces fonctions cote appelant.

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

function defaultData(){
  return {
    ownerId: null,          // ID Telegram numerique du proprietaire
    admins: [],             // [{ id, name }]
    accounts: {},           // username -> { telegramId, displayName, password, plan, status, expiresAt }
    pendingRequests: {}      // requestId -> { username, displayName, telegramId }
  };
}

function load(){
  if(!fs.existsSync(DATA_FILE)){
    save(defaultData());
  }
  try{
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }catch(e){
    console.error('Erreur de lecture de data.json, reinitialisation.', e);
    const fresh = defaultData();
    save(fresh);
    return fresh;
  }
}

function save(data){
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = { load, save };
