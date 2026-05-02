const http = require('http');
const PORT = 3000;
const API_KEY = ''; // inserisci la tua API key se serve

/* ================================================================
   TTL E LIMITI
   ================================================================ */
const CACHE_TTL = 5 * 60 * 1000;         // 5 minuti per la lista elezioni
const DETAIL_TTL_ELECTION = 30 * 60 * 1000; // 30 minuti per dettagli elezione
const DETAIL_TTL_PARTY    = 30 * 60 * 1000; // 30 minuti per dettagli partito
const DETAIL_TTL_USER     = 15 * 60 * 1000; // 15 minuti per dati utente
const MAX_CACHE_ENTRIES   = 500;           // massimo numero di entry per ogni mappa

const BAD_IDS = new Set();

/* ================================================================
   CACHE GLOBALE (fix #4 – spostata da countryCache a oggetti flat)
   Ogni entry è { data, ts } per permettere il controllo TTL ed LRU.
   ================================================================ */
const globalCache = {
  elections: new Map(),        // countryId -> { data, ts }
  electionDetails: new Map(),  // electionId -> { data, ts }
  partyDetails: new Map(),     // partyId -> { data, ts }
  userDetails: new Map(),      // userId -> { data, ts }
  parties: new Map(),         // countryId -> { data, ts } (elenco partiti)
};

// Timestamp per sapere quando è stata aggiornata l'ultima volta la lista elezioni
let lastElectionsFetch = 0;

/* ================================================================
   FUNZIONE LRU – Rimuove le entry più vecchie se si supera il limite
   ================================================================ */
function enforceCacheLimit(cacheMap, maxEntries) {
  while (cacheMap.size > maxEntries) {
    const oldestKey = cacheMap.keys().next().value;  // Map mantiene l'ordine
    cacheMap.delete(oldestKey);
  }
}

/* ================================================================
   FUNZIONE DI FETCH VERSO LE API REALI (invariata)
   ================================================================ */
async function wareraFetch(base, proc, input, isPost = false) {
  let url = `${base}/${proc}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(API_KEY && { Authorization: `Bearer ${API_KEY}` })
  };

  if (isPost) {
    url += '?batch=1';
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ 0: input })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json?.[0]?.result?.data ?? null;
  } else {
    const query = `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await fetch(url + query, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json?.result?.data ?? json;
  }
}

/* ================================================================
   AGGIORNA LISTA ELEZIONI (con cache TTL)
   ================================================================ */
async function refreshElectionsList(countryId) {
  const now = Date.now();
  const cacheEntry = globalCache.elections.get(countryId);

  if (cacheEntry && (now - cacheEntry.ts < CACHE_TTL)) {
    console.log(`   📋 Elezioni per ${countryId} già in cache`);
    return cacheEntry.data;
  }

  console.log(`   📡 Aggiornamento elezioni per ${countryId}...`);
  try {
    const data = await wareraFetch('https://api5.warera.io/trpc', 'election.getElections', {
      countryId, limit: 100, direction: 'forward'
    });
    const items = data?.items || data?.results || [];
    globalCache.elections.set(countryId, { data: items, ts: now });
    enforceCacheLimit(globalCache.elections, MAX_CACHE_ENTRIES);
    console.log(`   ✅ ${items.length} elezioni trovate.`);
    return items;
  } catch (err) {
    console.error(`   ❌ Errore per ${countryId}:`, err.message);
    // Se fallisce, ritorna la cache vecchia (se esiste) altrimenti array vuoto
    const fallback = globalCache.elections.get(countryId);
    return fallback ? fallback.data : [];
  }
}

/* ================================================================
   PRERISCALDAMENTO (invariato, ma usa refreshElectionsList)
   ================================================================ */
async function preloadAllCountries() {
  console.log('🌍 Preload: scarico lista nazioni...');
  let countries = [];
  try {
    const all = await wareraFetch('https://api5.warera.io/trpc', 'country.getAllCountries', {});
    countries = all?.items || all?.results || all || [];
  } catch (err) {
    console.error('❌ Errore durante il preload delle nazioni:', err.message);
    return;
  }

  if (!Array.isArray(countries) || countries.length === 0) {
    console.warn('⚠️ Nessuna nazione ricevuta. Uso solo Italia.');
    return;
  }

  const sorted = countries.sort((a, b) => (b.population || 0) - (a.population || 0));
  console.log(`✅ ${sorted.length} nazioni trovate. Inizio preriscaldamento con pausa di 2 secondi...`);

  for (const country of sorted) {
    if (!country._id) continue;
    await new Promise(resolve => setTimeout(resolve, 2000));

    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await refreshElectionsList(country._id);
        break;
      } catch (err) {
        if (err.message.includes('429')) {
          const wait = attempt * 5000;
          console.log(`   ⏳ ${country._id} ratelimit. Ritento fra ${wait / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, wait));
        } else {
          console.error(`   ❌ Errore definitivo per ${country._id}: ${err.message}`);
          break;
        }
      }
    }
  }

  console.log('🏁 Preriscaldamento completato!');
}

/* ================================================================
   HELPER PER AGGIUNGERE IN CACHE CON TTL E LIMITE
   ================================================================ */
function addToCache(map, key, data, maxEntries) {
  map.set(key, { data, ts: Date.now() });
  enforceCacheLimit(map, maxEntries);
}

function getFromCache(map, key, ttl) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) {
    map.delete(key);  // scaduta, la rimuoviamo
    return null;
  }
  return entry.data;
}

/* ================================================================
   SERVER HTTP
   ================================================================ */
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, ngrok-skip-browser-warning');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  const respond = (data, status = 200) => {
    try {
      const json = JSON.stringify(data);
      res.writeHead(status);
      res.end(json);
    } catch (e) {
      console.error('❌ Errore serializzazione JSON:', e.message);
      res.writeHead(500);
      res.end('{}');
    }
  };

  try {
    // 1. Lista elezioni (per paese)
    if (path === '/api/elections') {
      const countryId = url.searchParams.get('countryId') || '6813b6d446e731854c7ac7a2';
      const items = await refreshElectionsList(countryId);
      respond({ items });
      return;
    }

    // 2. Dettaglio elezione
    if (path === '/api/election') {
      const electionId = url.searchParams.get('id');
      if (!electionId) return respond({ error: 'Missing id' }, 400);
      if (BAD_IDS.has(electionId)) return respond({});

      // Cerca nella cache globale (fix #1, #4)
      let cached = getFromCache(globalCache.electionDetails, electionId, DETAIL_TTL_ELECTION);
      if (cached) return respond(cached);

      console.log(`📡 Richiesta dettagli elezione ${electionId}...`);
      try {
        const data = await wareraFetch('https://api5.warera.io/trpc', 'election.getElection', { electionId });
        if (data) {
          addToCache(globalCache.electionDetails, electionId, data, MAX_CACHE_ENTRIES);
        }
        respond(data || {});
      } catch (err) {
        console.error(`❌ Elezione ${electionId} non disponibile: ${err.message}`);
        BAD_IDS.add(electionId);
        respond({});
      }
      return;
    }

    // 3. Dettaglio partito
    if (path === '/api/party') {
      const partyId = url.searchParams.get('id');
      if (!partyId) return respond({ error: 'Missing id' }, 400);

      // Cerca nella cache globale con TTL (fix #2 – ora controlliamo il timestamp che prima ignoravamo)
      let cached = getFromCache(globalCache.partyDetails, partyId, DETAIL_TTL_PARTY);
      if (cached) return respond(cached);

      console.log(`📡 Richiesta dettagli partito ${partyId}...`);
      try {
        const data = await wareraFetch('https://api2.warera.io/trpc', 'party.getById', { partyId }, true);
        if (data) {
          addToCache(globalCache.partyDetails, partyId, data, MAX_CACHE_ENTRIES);
        }
        respond(data || {});
      } catch (err) {
        console.error(`❌ Partito ${partyId} non trovato: ${err.message}`);
        respond({});
      }
      return;
    }

    // 4. Dati utente
    if (path === '/api/user') {
      const userId = url.searchParams.get('id');
      if (!userId) return respond({ error: 'Missing id' }, 400);

      let cached = getFromCache(globalCache.userDetails, userId, DETAIL_TTL_USER);
      if (cached) return respond(cached);

      console.log(`📡 Richiesta dati utente ${userId}...`);
      try {
        const data = await wareraFetch('https://api2.warera.io/trpc', 'user.getUserLite', { userId });
        if (data) {
          addToCache(globalCache.userDetails, userId, data, MAX_CACHE_ENTRIES);
        }
        respond(data || {});
      } catch (err) {
        console.error(`❌ Utente ${userId} non trovato: ${err.message}`);
        respond({});
      }
      return;
    }

    // 5. Lista paesi
    if (path === '/api/countries') {
      const ALL_COUNTRIES_TTL = 24 * 60 * 60 * 1000; // 24 ore
      let countriesData = getFromCache(globalCache.electionDetails, '__all__', ALL_COUNTRIES_TTL); // riutilizzo 'electionDetails' come cache generica? No, meglio avere un key separato. Userò un'altra chiave.
      // Piccolo fix: creiamo un'altra chiave 'allCountries' nella globalCache
      const allKey = 'all_countries';
      let cachedCountries = globalCache.userDetails.get(allKey); // abusiamo di userDetails? No, meglio creare un'altra mappa. 
      // Visto che globalCache non ha una mappa dedicata per la lista paesi, ne aggiungo una:
      if (!globalCache.countries) globalCache.countries = new Map();
      let cached = getFromCache(globalCache.countries, allKey, ALL_COUNTRIES_TTL);
      if (cached) return respond({ items: cached });

      console.log('📡 Richiesta lista nazioni...');
      try {
        const data = await wareraFetch('https://api5.warera.io/trpc', 'country.getAllCountries', {});
        const items = data?.items || data?.results || data || [];
        addToCache(globalCache.countries, allKey, items, 1); // max 1 entry, tanto è una lista
        respond({ items });
      } catch (err) {
        console.error('❌ Errore recupero nazioni:', err.message);
        respond({ items: globalCache.countries.get(allKey)?.data || [] });
      }
      return;
    }

    // 6. Lista partiti di una nazione
    if (path === '/api/parties') {
      const countryId = url.searchParams.get('countryId') || '6813b6d446e731854c7ac7a2';
      const PARTIES_TTL = 60 * 60 * 1000; // 1 ora
      let cached = getFromCache(globalCache.parties, countryId, PARTIES_TTL);
      if (cached) return respond({ items: cached });

      console.log(`📡 Richiesta lista partiti per ${countryId}...`);
      try {
        const data = await wareraFetch('https://api2.warera.io/trpc', 'party.getManyPaginated', {
          countryId, limit: 100, direction: 'forward'
        }, true);
        const items = data?.items || data?.results || data || [];
        addToCache(globalCache.parties, countryId, items, MAX_CACHE_ENTRIES);
        respond({ items });
      } catch (err) {
        console.error(`❌ Errore recupero partiti per ${countryId}:`, err.message);
        respond({ items: globalCache.parties.get(countryId)?.data || [] });
      }
      return;
    }

    respond({ error: 'Not found' }, 404);
  } catch (err) {
    console.error('❌ Errore del server:', err.stack || err.message);
    respond({ error: err.message }, 500);
  }
});

/* ================================================================
   FIX #3 – Svuota BAD_IDS ogni ora
   ================================================================ */
setInterval(() => {
  if (BAD_IDS.size > 0) {
    console.log('🧹 Pulizia BAD_IDS (ogni ora)');
    BAD_IDS.clear();
  }
}, 60 * 60 * 1000);

/* ================================================================
   AVVIO SERVER
   ================================================================ */
server.listen(PORT, async () => {
  console.log(`🚀 Server proxy attivo su http://localhost:${PORT}`);
  preloadAllCountries();
});