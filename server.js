const http = require('http');
const PORT = 3000;
const API_KEY = ''; 

const CACHE_TTL = 5 * 60 * 1000; 
const BAD_IDS = new Set();

const countryCache = {};

function getCountryCache(countryId) {
  if (!countryCache[countryId]) {
    countryCache[countryId] = {
      elections: null,
      lastElectionsFetch: 0,
      electionDetails: {},
      partyDetails: {},
      lastPartyFetch: {},
      userDetails: {},
      parties: null,           // ← nuova proprietà
      lastPartiesFetch: 0      // ← nuova proprietà
    };
  }
  return countryCache[countryId];
}

/* ---- Chiamata alle API reali ---- */
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

/* ---- Aggiorna la lista elezioni per un singolo paese ---- */
async function refreshElectionsList(countryId) {
  const cache = getCountryCache(countryId);
  console.log(`   📡 Aggiornamento elezioni per ${countryId}...`);
  try {
    const data = await wareraFetch('https://api5.warera.io/trpc', 'election.getElections', { countryId, limit: 100, direction: 'forward' });
    cache.elections = data?.items || data?.results || [];
    cache.lastElectionsFetch = Date.now();
    console.log(`   ✅ ${cache.elections.length} elezioni trovate.`);
  } catch (err) {
    console.error(`   ❌ Errore per ${countryId}:`, err.message);
    cache.elections = cache.elections || [];
    throw err; // Rilancia per gestire il 429
  }
}

/* ---- PRERISCALDAMENTO con pausa di 2 secondi e retry automatico ---- */
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

  // Ordina per popolazione (se presente) oppure alfabetico
  const sorted = countries.sort((a, b) => (b.population || 0) - (a.population || 0));

  console.log(`✅ ${sorted.length} nazioni trovate. Inizio preriscaldamento con pausa di 2 secondi...`);

  for (const country of sorted) {
    if (!country._id) continue;

    // Attendi 2 secondi prima di ogni richiesta
    await new Promise(resolve => setTimeout(resolve, 2000));

    let success = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await refreshElectionsList(country._id);
        success = true;
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

    if (!success) {
      console.warn(`   ⚠️ Impossibile scaricare le elezioni per ${country._id} dopo 5 tentativi.`);
    }
  }

  console.log('🏁 Preriscaldamento completato!');
}

/* ---- Server HTTP ---- */
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
    // 1. Lista elezioni
    if (path === '/api/elections') {
      const countryId = url.searchParams.get('countryId') || '6813b6d446e731854c7ac7a2';
      const cache = getCountryCache(countryId);
      if (!cache.elections || Date.now() - cache.lastElectionsFetch > CACHE_TTL) {
        await refreshElectionsList(countryId);
      }
      respond({ items: cache.elections || [] });
      return;
    }

    // 2. Dettaglio elezione
    if (path === '/api/election') {
      const electionId = url.searchParams.get('id');
      if (!electionId) return respond({ error: 'Missing id' }, 400);
      if (BAD_IDS.has(electionId)) return respond({});

      for (const cid of Object.keys(countryCache)) {
        if (countryCache[cid]?.electionDetails?.[electionId]) {
          return respond(countryCache[cid].electionDetails[electionId]);
        }
      }

      console.log(`📡 Richiesta dettagli elezione ${electionId}...`);
      try {
        const data = await wareraFetch('https://api5.warera.io/trpc', 'election.getElection', { electionId });
        if (data) {
          const country = data.country || 'unknown';
          const cache = getCountryCache(country);
          cache.electionDetails[electionId] = data;
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

      for (const cid of Object.keys(countryCache)) {
        if (countryCache[cid]?.partyDetails?.[partyId]) {
          return respond(countryCache[cid].partyDetails[partyId]);
        }
      }

      console.log(`📡 Richiesta dettagli partito ${partyId}...`);
      try {
        const data = await wareraFetch('https://api2.warera.io/trpc', 'party.getById', { partyId }, true);
        if (data) {
          const country = data.country || 'unknown';
          const cache = getCountryCache(country);
          cache.partyDetails[partyId] = data;
          cache.lastPartyFetch[partyId] = Date.now();
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

      for (const cid of Object.keys(countryCache)) {
        if (countryCache[cid]?.userDetails?.[userId]) {
          return respond(countryCache[cid].userDetails[userId]);
        }
      }

      console.log(`📡 Richiesta dati utente ${userId}...`);
      try {
        const data = await wareraFetch('https://api2.warera.io/trpc', 'user.getUserLite', { userId });
        if (data) {
          const fallback = Object.keys(countryCache)[0] || 'generic';
          const cache = getCountryCache(fallback);
          cache.userDetails[userId] = data;
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
      const allCache = getCountryCache('__all__');
      if (!allCache.countries || Date.now() - (allCache.lastCountriesFetch || 0) > 24 * 60 * 60 * 1000) {
        console.log('📡 Richiesta lista nazioni...');
        try {
          const data = await wareraFetch('https://api5.warera.io/trpc', 'country.getAllCountries', {});
          allCache.countries = data?.items || data?.results || data || [];
          allCache.lastCountriesFetch = Date.now();
        } catch (err) {
          console.error('❌ Errore recupero nazioni:', err.message);
          allCache.countries = allCache.countries || [];
        }
      }
      respond({ items: allCache.countries || [] });
      return;
    }
    // 6. Lista partiti di una nazione (con paginazione)
    if (path === '/api/parties') {
      const countryId = url.searchParams.get('countryId') || '6813b6d446e731854c7ac7a2';
      const cache = getCountryCache(countryId);
      if (!cache.parties || Date.now() - (cache.lastPartiesFetch || 0) > 60 * 60 * 1000) {
        console.log(`📡 Richiesta lista partiti per ${countryId}...`);
        try {
          const data = await wareraFetch('https://api2.warera.io/trpc', 'party.getManyPaginated', { countryId, limit: 100, direction: 'forward' }, true);
          cache.parties = data?.items || data?.results || data || [];
          cache.lastPartiesFetch = Date.now();
        } catch (err) {
          console.error(`❌ Errore recupero partiti per ${countryId}:`, err.message);
          cache.parties = cache.parties || [];
        }
      }
      respond({ items: cache.parties || [] });
      return;
    }

    respond({ error: 'Not found' }, 404);
  } catch (err) {
    console.error('❌ Errore del server:', err.stack || err.message);
    respond({ error: err.message }, 500);
  }
});

server.listen(PORT, async () => {
  console.log(`🚀 Server proxy attivo su http://localhost:${PORT}`);
  preloadAllCountries();
});