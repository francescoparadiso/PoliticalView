//const API_BASE = 'https://both-shelve-usher.ngrok-free.dev/api';
const API_BASE = 'http://localhost:3000/api';

const APP_BASE = 'https://app.warera.io';


const PALETTE = [
  '#3b82f6', '#22c55e', '#eab308', '#ef4444', '#a855f7',
  '#f97316', '#06b6d4', '#ec4899', '#84cc16', '#f43f5e',
  '#6366f1', '#14b8a6', '#d946ef', '#0ea5e9', '#f59e0b',
];
/* ── CACHE localStorage ── */
const CACHE_TTL_SHORT = 3 * 60 * 1000;   // 3 min per elezioni recenti
const CACHE_TTL_LONG = 60 * 60 * 1000;  // 1 ora per elezioni concluse

function cacheKey(path, params) {
  return 'we_' + path + '_' + JSON.stringify(params);
}
function cacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { data, ts, ttl } = JSON.parse(raw);
    if (Date.now() - ts > ttl) { localStorage.removeItem(key); return null; }
    return data;
  } catch (_) { return null; }
}
function cacheSet(key, data, ttl) {
  try { localStorage.setItem(key, JSON.stringify({ data, ts: Date.now(), ttl })); } catch (_) { }
}
function cacheClear() {
  try {
    Object.keys(localStorage).filter(k => k.startsWith('we_')).forEach(k => localStorage.removeItem(k));
  } catch (_) { }
}
/* ── PLUGIN centerText ── */
const centerTextPlugin = {
  id: 'centerText',
  afterDraw(chart) {
    if (!chart.config.options.plugins?.centerText?.text) return;
    const { ctx, chartArea: { left, top, right, bottom } } = chart;
    const cx = (left + right) / 2;
    const cy = bottom * 0.92;
    const cfg = chart.config.options.plugins.centerText;
    ctx.save();
    ctx.font = `700 ${cfg.fontSize || 16}px "Playfair Display", serif`;
    ctx.fillStyle = cfg.color || '#e8c97a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cfg.text, cx, cy);
    if (cfg.sub) {
      ctx.font = `400 ${(cfg.fontSize || 16) * 0.6}px "Sora", sans-serif`;
      ctx.fillStyle = cfg.subColor || '#8892a4';
      ctx.fillText(cfg.sub, cx, cy + (cfg.fontSize || 16));
    }
    ctx.restore();
  }
};
Chart.register(centerTextPlugin);

let _partyColorMap = new Map();
let _csvColorMap = new Map(); 
let _partyNamesMap = new Map();
let _seatsChart, _membersChart, _allPartiesChart, _presidentChart, _timelineChart;
let _apiKey = sessionStorage.getItem('we_key') || '';
let _pendingRequest = null;
let _electionHistory = [];
let _currentCongressElectionId = null;
let _timelineElectionIds = [];
let _currentCountryId = '6813b6d446e731854c7ac7a2';
let _currentCountryData = null;   // { population, name, ... }
let _historicTurnouts = [];       // [{ electionId, totalVotes, date }]
let _lastAllParties = null;   // per il simulatore, tutti i partiti

/* ── ABBR INTELLIGENTE ── */
function makeAbbr(name) {
  // Se il nome è mancante o non è una stringa, restituisci subito un segnaposto
  if (!name || typeof name !== 'string') return 'N/A';

  // Rimuovi apostrofi curvi e dritti, poi rimuovi qualsiasi carattere che NON sia una lettera o uno spazio
  const clean = name.replace(/['’\u2019\u2018]/g, '')
    .replace(/[^\p{L}\s]/gu, ' ')  // flag 'u' per Unicode
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) return 'N/A';

  // Prendi le iniziali delle prime 3 parole (o meno)
  const words = clean.split(' ');
  const initials = words
    .filter(w => w.length > 0)
    .map(w => w[0])
    .slice(0, 3)
    .join('')
    .toUpperCase();

  return initials || 'N/A';
}
/* ── COLORI GLOBALI ── */
function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  let color = '#';
  for (let i = 0; i < 3; i++) {
    const value = (hash >> (i * 8)) & 0xFF;
    color += ('00' + value.toString(16)).substr(-2);
  }
  return color;
}

function getPartyColor(partyId) {
  // 1. Colori permanenti dal CSV
  if (_csvColorMap.has(partyId)) return _csvColorMap.get(partyId);
  // 2. Colori già generati in sessione
  if (_partyColorMap.has(partyId)) return _partyColorMap.get(partyId);
  // 3. Altrimenti genera e salva nei temporanei
  const color = stringToColor(partyId);
  _partyColorMap.set(partyId, color);
  return color;
}
/* ── FETCH VERSO IL SERVER LOCALE ── */
async function localFetch(path, params = {}, { useCache = true, ttl = null } = {}) {
  const key = cacheKey(path, params);
  if (useCache) {
    const cached = cacheGet(key);
    if (cached) return cached;
  }
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}${qs ? '?' + qs : ''}`;
  const headers = {
    ...(_apiKey && { Authorization: `Bearer ${_apiKey}` }),
    'ngrok-skip-browser-warning': 'true'
  };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} → ${path}`);
  const json = await res.json();
  // Determina TTL: breve per elezioni in corso, lungo per dati stabili
  if (useCache) {
    const autoTtl = ttl ?? (path === '/election' ? CACHE_TTL_SHORT : CACHE_TTL_LONG);
    cacheSet(key, json, autoTtl);
  }
  return json;
}

/* ── HELPERS ── */
function setStatus(msg, type = '') {
  const el = document.getElementById('statusBadge');
  el.textContent = msg; el.className = 'badge-status ' + type;
}
function fillStat(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = val;
  el.classList.remove('skeleton-val');
  el.classList.add('loaded');
}
function resetStats() {
  ['stat-seats', 'stat-parties', 'stat-totalvotes', 'stat-majority', 'stat-leader'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = '—';
    el.classList.add('skeleton-val');
    el.classList.remove('loaded');
  });
  const enpLabel = document.getElementById('stat-enp-label');
  if (enpLabel) { enpLabel.textContent = '—'; enpLabel.style.color = ''; }
}
function safeDestroy(canvasId) {
  const existing = Chart.getChart(canvasId);
  if (existing) existing.destroy();
}
function showView(which) {
  document.getElementById('president-view').style.display = which === 'president' ? '' : 'none';
  document.getElementById('congress-view').style.display = which === 'congress' ? '' : 'none';
}

/* ── SKELETON HELPERS ── */
function showSkeleton() {
  document.getElementById('parliamentSkeleton').style.display = '';
  document.getElementById('parliamentContainer').style.display = 'none';
  document.getElementById('tableSkeleton').style.display = '';
  document.getElementById('partyTable').style.display = 'none';
  ['seatsChart', 'membersChart'].forEach(id => {
    const c = document.getElementById(id);
    const sk = c?.previousElementSibling;
    if (sk && sk.classList.contains('sk-chart-block')) sk.style.display = '';
    if (c) c.style.display = 'none';
  });
  const apCanvas = document.getElementById('allPartiesChart');
  const apSk = apCanvas?.previousElementSibling;
  if (apSk && apSk.classList.contains('sk-chart-block')) apSk.style.display = '';
  if (apCanvas) apCanvas.style.display = 'none';
}
function hideSkeleton() {
  document.getElementById('parliamentSkeleton').style.display = 'none';
  document.getElementById('parliamentContainer').style.display = '';
  document.getElementById('tableSkeleton').style.display = 'none';
  document.getElementById('partyTable').style.display = '';
  ['seatsChart', 'membersChart'].forEach(id => {
    const c = document.getElementById(id);
    const sk = c?.previousElementSibling;
    if (sk && sk.classList.contains('sk-chart-block')) sk.style.display = 'none';
    if (c) c.style.display = '';
  });
  const apCanvas = document.getElementById('allPartiesChart');
  const apSk = apCanvas?.previousElementSibling;
  if (apSk && apSk.classList.contains('sk-chart-block')) apSk.style.display = 'none';
  if (apCanvas) apCanvas.style.display = '';
}

/* ── CARICAMENTO NAZIONI (fallback Italia) ── */
async function loadCountries() {
  const select = document.getElementById('countrySelect');
  if (!select) return;

  // Inizializza Tom Select (distrugge eventuale istanza precedente)
  if (select.tomselect) {
    select.tomselect.destroy();
  }

  // Configura Tom Select con ricerca
  const tomSelect = new TomSelect(select, {
    placeholder: 'Search country…',
    allowEmptyOption: true,
    create: false,
    sortField: { field: 'text', direction: 'asc' },
    maxOptions: null,
    // Questa opzione fa sì che l'utente possa digitare per filtrare
    shouldSort: true,
  });

  try {
    const data = await localFetch('/countries');
    const items = data?.items || [];

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('No countries found');
    }

    // Ordina alfabeticamente e popola Tom Select
    items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    items.forEach(c => {
      tomSelect.addOption({
        value: c._id,
        text: c.name || c._id,
      });
    });

    // Seleziona l'Italia se presente, altrimenti la prima opzione
    const italyOption = tomSelect.options['6813b6d446e731854c7ac7a2'];
    if (italyOption) {
      tomSelect.setValue('6813b6d446e731854c7ac7a2');
    } else {
      tomSelect.setValue(Object.keys(tomSelect.options)[0] || '');
    }

    // Salva l'istanza Tom Select per poterla usare dopo
    select.tomselect = tomSelect;

  } catch (err) {
    console.warn('⚠️ Unable to load countries:', err.message);

    // Fallback: inserisci solo l'Italia
    tomSelect.addOption({
      value: '6813b6d446e731854c7ac7a2',
      text: 'Italy',
    });
    tomSelect.setValue('6813b6d446e731854c7ac7a2');
    select.tomselect = tomSelect;
  }
}

/* ── EXPORT CSV ── */
function exportCSV(parties, filename = 'parliament.csv') {
  if (!parties || !parties.length) { alert('No data to export.'); return; }
  const headers = ['Party', 'Abbr', 'Seats', 'Members', 'Votes', 'Seat %', 'Leader', 'Color'];
  const totalSeats = parties.reduce((s, p) => s + p.seats, 0);
  const rows = parties.map(p => [
    `"${p.name.replace(/"/g, '""')}"`,
    p.abbr,
    p.seats,
    p.members,
    p.votes,
    totalSeats ? ((p.seats / totalSeats) * 100).toFixed(2) : 0,
    `"${(p.leaderName || '').replace(/"/g, '""')}"`,
    p.color,
  ]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function openParliamentFullscreen() {
  const container = document.getElementById('parliamentContainer');
  const overlay = document.getElementById('parliamentOverlay');
  const dest = document.getElementById('parliamentOverlayContent');
  if (!container || !overlay || !dest) return;

  const svg = container.querySelector('svg');
  if (!svg) return;

  // Salva i riferimenti per poterlo rimettere a posto
  overlay._svg = svg;
  overlay._originalParent = svg.parentNode;

  // Sposta il SVG nell'overlay
  dest.innerHTML = '';
  svg.style.width = '100%';
  svg.style.height = '100%';
  dest.appendChild(svg);

  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeParliamentFullscreen() {
  const overlay = document.getElementById('parliamentOverlay');
  if (!overlay) return;

  overlay.classList.remove('active');
  document.body.style.overflow = '';

  // Riporta il SVG al container originale
  if (overlay._svg && overlay._originalParent) {
    overlay._svg.style.width = '';
    overlay._svg.style.height = '';
    overlay._originalParent.appendChild(overlay._svg);
    overlay._svg = null;
    overlay._originalParent = null;
  }
}
/* ── STORICO ELEZIONI + TIMELINE ── */
async function loadElectionsHistory() {
  try {
    const data = await localFetch('/elections', { countryId: _currentCountryId });
    const items = (data?.items || []).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    _electionHistory = items;

    const select = document.getElementById('electionSelect');
    while (select.options.length > 1) select.remove(1);
    [...items].reverse().forEach(e => {
      const opt = document.createElement('option');
      opt.value = e._id;
      const emoji = e.type === 'president' ? '👤' : '🏛️';
      const date = new Date(e.createdAt).toLocaleDateString('it');
      opt.textContent = `${emoji} ${e.type === 'president' ? 'Presidenziale' : 'Congresso'} · ${date}`;
      select.appendChild(opt);
    });

    const congressElections = items.filter(e => e.type === 'congress');
    _currentCongressElectionId = congressElections.length > 0 ? congressElections[congressElections.length - 1]._id : null;
    renderTimeline(congressElections.slice(-6));

    if (items.length > 0) {
      const latest = [...items].reverse()[0];
      select.value = latest._id;
      document.getElementById('electionIdInput').value = latest._id;
      await loadElection(latest._id);
    }
  } catch (err) {
    console.warn('Storico elezioni non disponibile:', err.message);
  }
}
async function loadPartiesForCountry(countryId) {
  try {
    const data = await localFetch('/parties', { countryId });
    const parties = data?.items || [];
    parties.forEach(p => {
      if (!_partyColorMap.has(p._id)) {
        _partyColorMap.set(p._id, stringToColor(p._id));
      }
      _partyNamesMap.set(p._id, p.name);
    });
    return parties;   // <-- restituisce l'array
  } catch (err) {
    console.warn('Unable to load party list:', err.message);
    return [];
  }
}
/* ── TIMELINE ── */
function renderTimeline(congressElections) {
  if (congressElections.length < 2) return;

  const panel = document.getElementById('timelinePanel');
  panel.style.display = '';
  safeDestroy('timelineChart');

  const labels = congressElections.map(e => new Date(e.createdAt).toLocaleDateString('it', { month: 'short', year: '2-digit' }));
  const electionIds = congressElections.map(e => e._id);
  const canvas = document.getElementById('timelineChart');
  const ctx = canvas.getContext('2d');
  _timelineElectionIds = electionIds;

  _timelineChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f1521',
          borderColor: 'rgba(197,150,74,.3)',
          borderWidth: 1,
          titleColor: '#e8c97a',
          bodyColor: '#8892a4',
          padding: 10,
          cornerRadius: 6,
          callbacks: {
            title: items => `Elezione ${items[0].label}`,
            label: (item) => {
              if (!item.dataset.label) return '';
              return ` ${item.dataset.label}: ${item.parsed.y} seggi`;
            }
          }
        },
      },
      scales: {
        x: {
          ticks: { color: '#535e72', font: { size: 11 } },
          grid: { color: 'rgba(255,255,255,0.035)' },
          border: { color: 'rgba(255,255,255,0.06)' },
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#535e72', stepSize: 1 },
          grid: { color: 'rgba(255,255,255,0.035)' },
          border: { color: 'rgba(255,255,255,0.06)' },
        },
      },
      onClick: (evt, elements, chart) => {
        if (!elements.length) return;
        const idx = elements[0].index;
        const eid = electionIds[idx];
        if (eid) {
          document.getElementById('electionSelect').value = eid;
          document.getElementById('electionIdInput').value = eid;
          loadElection(eid);
        }
      },
    },
  });

  loadTimelineData(congressElections, electionIds);
}

async function loadTimelineData(elections, electionIds) {
  const partySeatsPerElection = [];

  for (const election of elections) {
    try {
      const data = await localFetch('/election', { id: election._id });
      const elected = (data?.candidates || []).filter(c => c.isElected);
      const seatMap = {};
      elected.forEach(c => {
        const pid = String(c.party || c.partyId || 'independent');
        seatMap[pid] = (seatMap[pid] || 0) + 1;
      });
      partySeatsPerElection.push(seatMap);
    } catch (_) {
      partySeatsPerElection.push({});
    }
  }

  const allPids = new Set();
  partySeatsPerElection.forEach(m => Object.keys(m).forEach(pid => allPids.add(pid)));

  // ---- NUOVO: precarica i nomi dei partiti se mancano ----
  for (const pid of allPids) {
    if (pid === 'independent') continue;
    if (!_partyNamesMap.has(pid)) {
      try {
        const partyData = await localFetch('/party', { id: pid });
        if (partyData && partyData.name) {
          _partyNamesMap.set(pid, partyData.name);
        }
      } catch (_) {
        // Se non riesce, useremo l'ID abbreviato
      }
    }
  }

  // Popola _historicTurnouts per il simulatore
  _historicTurnouts = [];
  for (const election of elections) {
    try {
      const data = await localFetch('/election', { id: election._id });
      const totalVotes = data.votesCount || (data.candidates || []).reduce((s, c) => s + (c.voteCount || 0), 0);
      _historicTurnouts.push({
        electionId: election._id,
        totalVotes: totalVotes || 0,
        date: election.createdAt,
        seats: (data.candidates || []).filter(c => c.isElected).length
      });
    } catch (_) { }
  }
  // --------------------------------------------------------

  const datasets = [];
  const legendDiv = document.getElementById('timelineLegend');
  legendDiv.innerHTML = '';

  let colorIdx = 0;
  for (const pid of allPids) {
    if (pid === 'independent') continue;
    const color = _partyColorMap.get(pid) || PALETTE[colorIdx % PALETTE.length];
    const name = _partyNamesMap.get(pid) || pid.slice(-6);   // ora dovrebbe esserci
    const data = partySeatsPerElection.map(m => m[pid] || 0);
    if (data.every(v => v === 0)) continue;

    const pointRadii = electionIds.map(eid => (eid === _currentCongressElectionId) ? 7 : 4);

    datasets.push({
      label: name,
      data,
      borderColor: color,
      backgroundColor: color + '22',
      borderWidth: 2,
      pointRadius: pointRadii,
      pointHoverRadius: pointRadii.map(r => r + 2),
      pointBackgroundColor: color,
      tension: 0.3,
      fill: false,
    });

    if (data.length >= 2) {
      const movingAvg = data.map((v, i) => (i === 0) ? v : Math.round((data[i - 1] + data[i]) / 2));
      datasets.push({
        label: '',
        data: movingAvg,
        borderColor: color,
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [4, 3],
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.3,
        fill: false,
      });
    }

    const item = document.createElement('div');
    item.className = 'tl-leg-item';
    item.innerHTML = `<span class="tl-leg-dot" style="background:${color}"></span>${name}`;
    legendDiv.appendChild(item);

    colorIdx++;
  }

  if (_timelineChart && datasets.length) {
    _timelineChart.data.datasets = datasets;
    _timelineChart.update('active');
    document.getElementById('timelineBadge').textContent = `${elections.length} elections`;
  }
}

function updateTimelineHighlight() {
  if (!_timelineChart || !_timelineElectionIds.length || !_currentCongressElectionId) return;
  const ids = _timelineElectionIds;
  _timelineChart.data.datasets.forEach(dataset => {
    if (!dataset.label) return;
    dataset.pointRadius = ids.map(eid => (eid === _currentCongressElectionId) ? 7 : 4);
    dataset.pointHoverRadius = dataset.pointRadius.map(r => r + 2);
  });
  _timelineChart.update('none');
}

/* ── TABELLA PARTITI ── */
function renderPartyTable(electedParties, totalSeats) {
  const sorted = [...electedParties].sort((a, b) => b.seats - a.seats);
  document.getElementById('partyTableBody').innerHTML = sorted.map(p => {
    const pct = totalSeats ? ((p.seats / totalSeats) * 100).toFixed(1) : 0;
    const barW = totalSeats ? (p.seats / totalSeats * 100).toFixed(1) : 0;
    const leaderAvatar = p.leaderAvatarUrl
      ? `<img src="${p.leaderAvatarUrl}" class="avatar-small" alt="">`
      : `<span class="avatar-placeholder">👤</span>`;
    const leaderEl = p.leaderId
      ? `<a href="${APP_BASE}/user/${p.leaderId}" target="_blank" class="leader-link">${leaderAvatar} ${p.leaderName || '—'}</a>`
      : `<span class="leader-chip">${leaderAvatar} ${p.leaderName || '—'}</span>`;
    return `<tr>
      <td><div class="party-name-cell"><span class="party-color-bar" style="background:${p.color}"></span><span>${p.name}</span></div></td>
      <td><div class="seats-bar-wrap"><div class="seats-bar"><div class="seats-bar-fill" style="width:${barW}%;background:${p.color}"></div></div><span class="seats-num">${p.seats}</span></div></td>
      <td>${p.members}</td>
      <td>${p.votes.toLocaleString()}</td>
      <td><span class="party-pct">${pct}%</span></td>
      <td>${leaderEl}</td>
    </tr>`;
  }).join('');
}

/* ── GRAFICI CONGRESSO ── */
function renderCharts(electedParties) {
  safeDestroy('seatsChart');
  safeDestroy('membersChart');
  if (!electedParties.length) return;

  const totalSeats = electedParties.reduce((s, p) => s + p.seats, 0);
  const colors = electedParties.map(p => p.color);
  const colorsA = colors.map(c => c + 'cc');
  const tt = {
    backgroundColor: '#0f1521', borderColor: 'rgba(197,150,74,.3)',
    borderWidth: 1, titleColor: '#e8c97a', bodyColor: '#8892a4',
    padding: 10, cornerRadius: 6
  };

  _seatsChart = new Chart(document.getElementById('seatsChart').getContext('2d'), {
    type: 'doughnut',
    data: { labels: electedParties.map(p => p.name), datasets: [{ data: electedParties.map(p => p.seats), backgroundColor: colorsA, borderColor: '#0e1117', borderWidth: 3, hoverBorderColor: colors, hoverBorderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '65%', rotation: -90, circumference: 180,
      plugins: {
        legend: { display: false },
        tooltip: { ...tt, callbacks: { title: i => i[0].label, label: i => ` ${i.raw} seggi (${((i.raw / totalSeats) * 100).toFixed(1)}%) · ${electedParties[i.dataIndex].votes.toLocaleString()} voti` } },
        centerText: { text: `${totalSeats}`, sub: 'seggi', fontSize: 20, color: '#e8c97a', subColor: '#8892a4' },
      },
      onClick: (_, el) => { if (el.length) window.open(`${APP_BASE}/party/${electedParties[el[0].index].id}`, '_blank'); }
    },
  });

  _membersChart = new Chart(document.getElementById('membersChart').getContext('2d'), {
    type: 'bar',
    data: { labels: electedParties.map(p => p.abbr), datasets: [{ data: electedParties.map(p => Number(p.members) || 0), backgroundColor: colorsA, borderColor: colors, borderWidth: 1.5, borderRadius: 5, borderSkipped: false }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { ...tt, callbacks: { title: i => electedParties[i[0].dataIndex].name, label: i => `${i.raw} iscritti` } } },
      scales: {
        y: { beginAtZero: true, ticks: { color: '#535e72' }, grid: { color: 'rgba(255,255,255,0.035)' }, border: { color: 'rgba(255,255,255,0.06)' } },
        x: { ticks: { color: '#8892a4', font: { size: 11 } }, grid: { display: false }, border: { color: 'rgba(255,255,255,0.06)' } }
      },
      onClick: (_, el) => { if (el.length) window.open(`${APP_BASE}/party/${electedParties[el[0].index].id}`, '_blank'); }
    },
  });
}

/* ── ALL PARTIES CHART (orizzontale) ── */
function renderAllPartiesChart(allParties) {
  safeDestroy('allPartiesChart');
  if (!allParties.length) return;

  const sorted = [...allParties].sort((a, b) => b.members - a.members);

  const tt = {
    backgroundColor: '#0f1521', borderColor: 'rgba(197,150,74,.3)',
    borderWidth: 1, titleColor: '#e8c97a', bodyColor: '#8892a4',
    padding: 10, cornerRadius: 6
  };

  const barH = Math.max(24, Math.min(34, 300 / sorted.length));
  const totalH = Math.max(240, sorted.length * (barH + 6));
  const wrap = document.getElementById('allPartiesChartWrap');
  wrap.style.height = totalH + 'px';

  _allPartiesChart = new Chart(document.getElementById('allPartiesChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: sorted.map(p => p.name), datasets: [{
        data: sorted.map(p => Number(p.members) || 0),
        backgroundColor: sorted.map(p => p.seats > 0 ? p.color + 'ff' : p.color + '33'),
        borderColor: sorted.map(p => p.seats > 0 ? p.color : p.color + '44'),
        borderWidth: 1.5, borderRadius: 4, borderSkipped: false,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { ...tt, callbacks: { title: i => sorted[i[0].dataIndex].name, label: i => { const p = sorted[i.dataIndex]; return `${i.raw} iscritti` + (p.seats > 0 ? ` · ${p.seats} seggi 🏛` : ''); } } } },
      scales: {
        x: { beginAtZero: true, ticks: { color: '#535e72', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.035)' }, border: { color: 'rgba(255,255,255,0.06)' } },
        y: { ticks: { color: ctx => sorted[ctx.index]?.seats > 0 ? '#dde2ec' : '#535e72', font: ctx => ({ size: 11, weight: sorted[ctx.index]?.seats > 0 ? '600' : '400' }) }, grid: { display: false }, border: { color: 'rgba(255,255,255,0.06)' } },
      },
      onClick: (_, el) => { if (el.length) window.open(`${APP_BASE}/party/${sorted[el[0].index].id}`, '_blank'); }
    },
  });
  document.getElementById('badgeAllParties').textContent = `${allParties.length} partiti`;
}
async function loadPartyColors(csvUrl) {
  try {
    const res = await fetch(csvUrl);
    if (!res.ok) throw new Error('CSV not found');
    const text = await res.text();
    text.split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const parts = line.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const id = parts[0];
        const color = parts[parts.length - 1]; // prende solo l'ultimo campo (il colore)
        if (id && color) _csvColorMap.set(id, color);   // ← salvato permanentemente
      }
    });
    console.log(`🎨 ${_csvColorMap.size} colors loaded from CSV`);
  } catch (err) {
    console.warn('CSV colors not loaded:', err.message);
  }
}
/* ── PRESIDENTIAL ── */
function renderPresidentialTurnoutChart(currentElectionId = null) {
  const presidentialElections = _electionHistory
    .filter(e => e.type === 'president')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  if (presidentialElections.length < 2) return;

  const canvas = document.getElementById('presidentTurnoutChart');
  if (!canvas) {
    console.warn('Canvas presidentTurnoutChart not found!');
    return;
  }

  // Destroy previous chart
  const existing = Chart.getChart(canvas);
  if (existing) existing.destroy();

  const labels = presidentialElections.map(e =>
    new Date(e.createdAt).toLocaleDateString('it', { month: 'short', year: '2-digit' })
  );
  const data = presidentialElections.map(e => e.votesCount || 0);
  const electionIds = presidentialElections.map(e => e._id);

  // Larger points for the current election
  const pointRadii = presidentialElections.map(e =>
    (currentElectionId && e._id === currentElectionId) ? 8 : 4
  );

  // 2‑point moving average
  const movingAverage = [];
  for (let i = 0; i < data.length; i++) {
    if (i === 0) {
      movingAverage.push(data[i]);
    } else {
      movingAverage.push(Math.round((data[i - 1] + data[i]) / 2));
    }
  }

  new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Total votes',
          data,
          borderColor: '#e8c97a',
          backgroundColor: 'rgba(232,201,122,0.1)',
          borderWidth: 2,
          pointRadius: pointRadii,
          pointHoverRadius: pointRadii.map(r => r + 4),
          pointHitRadius: 15,
          pointBackgroundColor: '#e8c97a',
          tension: 0.3,
          fill: true,
        },
        {
          label: 'Moving average (2)',
          data: movingAverage,
          borderColor: '#60a5fa',
          backgroundColor: 'transparent',
          borderWidth: 2,
          borderDash: [6, 3],
          pointRadius: 0,
          pointHoverRadius: 3,
          pointHitRadius: 0,
          tension: 0.3,
          fill: false,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'nearest',
        intersect: false,
        axis: 'x'
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f1521',
          borderColor: 'rgba(197,150,74,.3)',
          borderWidth: 1,
          titleColor: '#e8c97a',
          bodyColor: '#8892a4',
          padding: 10,
          cornerRadius: 6,
          callbacks: {
            title: items => `Election ${items[0].label}`,
            label: item => ` ${item.dataset.label}: ${item.parsed.y.toLocaleString()} votes`
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#535e72', font: { size: 11 } },
          grid: { color: 'rgba(255,255,255,0.035)' },
          border: { color: 'rgba(255,255,255,0.06)' }
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#535e72', callback: v => v.toLocaleString() },
          grid: { color: 'rgba(255,255,255,0.035)' },
          border: { color: 'rgba(255,255,255,0.06)' }
        }
      },
      onClick: (event, elements, chart) => {
        if (elements.length > 0) {
          const idx = elements[0].index;
          const eid = electionIds[idx];
          if (eid) {
            document.getElementById('electionSelect').value = eid;
            document.getElementById('electionIdInput').value = eid;
            loadElection(eid);
          }
        }
      }
    }
  });
}

async function loadPresidentialElection(election) {
  document.getElementById('timelinePanel').style.display = 'none';
  showView('president');
  resetStats();
  const candidates = [];
  for (const c of election.candidates) {
    const userData = await localFetch('/user', { id: c.user || c.userId });
    const votes = election.votes ? (election.votes[String(c.user || c.userId)] ?? c.voteCount ?? 0) : (c.voteCount ?? 0);
    candidates.push({ ...c, userData, votes, color: PALETTE[candidates.length % PALETTE.length] });
  }
  candidates.sort((a, b) => b.votes - a.votes);

  const totalVotes = election.votesCount || candidates.reduce((s, c) => s + c.votes, 0);
  fillStat('stat-totalvotes', totalVotes.toLocaleString());

  const winner = candidates.find(c => c.isElected) || candidates[0];
  const maxVotes = candidates[0]?.votes || 1;

  const now = new Date(), end = new Date(election.votesEndAt), start = new Date(election.votesStartAt);
  let statusText = '', statusClass = '';
  if (now < start) { statusText = '🗳 Candidatura'; statusClass = 'pres-badge-pending'; }
  else if (now <= end) { statusText = '🔴 Votazione in corso'; statusClass = 'pres-badge-live'; }
  else { statusText = '✅ Conclusa'; statusClass = 'pres-badge-done'; }
  const sb = document.getElementById('pres-status-badge');
  sb.textContent = statusText; sb.className = 'badge-count ' + statusClass;

  const banner = document.getElementById('pres-winner-banner');
  if (winner && now > end) {
    const av = winner.userData.avatarUrl
      ? `<img src="${winner.userData.avatarUrl}" class="pres-winner-avatar" alt="">`
      : `<div class="pres-winner-avatar pres-winner-initials">${winner.userData.username[0].toUpperCase()}</div>`;
    banner.style.display = '';
    banner.innerHTML = `
      <div class="pres-winner-left">${av}
        <div>
          <div class="pres-winner-label">🏆 Presidente eletto</div>
          <div class="pres-winner-name">${winner.userData.username}</div>
        </div>
      </div>
      <div class="pres-winner-votes">
        <div class="pres-winner-vcount">${winner.votes.toLocaleString()}</div>
        <div class="pres-winner-vsub">voti · ${totalVotes ? ((winner.votes / totalVotes) * 100).toFixed(1) + '%' : '—'}</div>
      </div>`;
    fillStat('stat-leader', winner.userData.username);
  } else {
    banner.style.display = 'none';
  }

  document.getElementById('pres-race').innerHTML = candidates.map((c, i) => {
    const pct = totalVotes ? ((c.votes / totalVotes) * 100).toFixed(1) : 0;
    const barW = maxVotes ? ((c.votes / maxVotes) * 100).toFixed(1) : 0;
    const isWin = c.isElected;
    const av = c.userData.avatarUrl
      ? `<img src="${c.userData.avatarUrl}" class="race-avatar" alt="">`
      : `<div class="race-avatar race-initials" style="background:${c.color}33;color:${c.color}">${c.userData.username[0].toUpperCase()}</div>`;
    return `<div class="race-row${isWin ? ' race-winner' : ''}">
      <div class="race-rank">${i + 1}</div>${av}
      <div class="race-info">
        <div class="race-name">${c.userData.username}${isWin ? ' <span class="race-win-chip">Eletto</span>' : ''}</div>
        <div class="race-bar-wrap"><div class="race-bar" style="width:${barW}%;background:${c.color}"></div></div>
      </div>
      <div class="race-stats">
        <div class="race-votes">${c.votes.toLocaleString()}</div>
        <div class="race-pct">${pct}%</div>
      </div>
    </div>`;
  }).join('');
  // Collasso automatico se ci sono più di 8 candidati
  const threshold = 6;
  const raceDiv = document.getElementById('pres-race');
  if (candidates.length > threshold) {
    const rows = raceDiv.querySelectorAll('.race-row');
    // Nasconde tutte le righe oltre la soglia
    rows.forEach((row, i) => {
      if (i >= threshold) {
        row.style.display = 'none';
        row.classList.add('collapsed-candidate');
      }
    });
    // Pulsante per mostrare/nascondere
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'race-toggle-btn';
    toggleBtn.textContent = `Show more (${candidates.length})`;
    toggleBtn.addEventListener('click', () => {
      const hiddenRows = raceDiv.querySelectorAll('.collapsed-candidate');
      const areHidden = hiddenRows[0]?.style.display === 'none';
      hiddenRows.forEach(r => r.style.display = areHidden ? '' : 'none');
      toggleBtn.textContent = areHidden ? 'Show less' : `Show more (${candidates.length})`;
    });
    raceDiv.appendChild(toggleBtn);
  }
  safeDestroy('presidentChart');
  _presidentChart = new Chart(document.getElementById('presidentChart').getContext('2d'), {
    type: 'bar',
    data: { labels: candidates.map(c => c.userData.username), datasets: [{ data: candidates.map(c => c.votes), backgroundColor: candidates.map(c => c.color + 'cc'), borderColor: candidates.map(c => c.color), borderWidth: 1.5, borderRadius: 6, borderSkipped: false }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#0f1521', borderColor: 'rgba(197,150,74,.3)', borderWidth: 1, titleColor: '#e8c97a', bodyColor: '#8892a4', padding: 10, cornerRadius: 6, callbacks: { title: i => candidates[i[0].dataIndex].userData.username, label: i => ` ${i.raw.toLocaleString()} voti (${totalVotes ? ((i.raw / totalVotes) * 100).toFixed(1) + '%' : '—'})` } } },
      scales: { y: { beginAtZero: true, ticks: { color: '#535e72' }, grid: { color: 'rgba(255,255,255,0.035)' } }, x: { ticks: { color: '#8892a4' }, grid: { display: false } } },
    },
  });

  document.getElementById('pres-meta').innerHTML = `
    <span>📅 Inizio: <strong>${new Date(election.votesStartAt).toLocaleDateString('it')}</strong></span>
    <span>⏱ Fine: <strong>${new Date(election.votesEndAt).toLocaleDateString('it')}</strong></span>
    <span>🗳 Voti totali: <strong>${totalVotes.toLocaleString()}</strong></span>
    <a href="${APP_BASE}/country/${election.country}/election/${election._id}" target="_blank" class="pres-meta-link">Vai all'elezione →</a>
  `;
  renderPresidentialTurnoutChart(election._id);
  document.getElementById('badgeCount').textContent = `Presidenziale · ${totalVotes} voti`;
}

/* ── CONGRESS ELECTION ── */
async function loadCongressElection(election) {
  document.getElementById('timelinePanel').style.display = '';
  showView('congress');
  _currentCongressElectionId = election._id;
  showSkeleton();
  resetStats();

  const totalVotes = election.votesCount || election.candidates.reduce((s, c) => s + (c.voteCount || 0), 0);
  fillStat('stat-totalvotes', totalVotes.toLocaleString());
  const elected = election.candidates.filter(c => c.isElected);
  if (!elected.length) throw new Error('No elected candidates found.');

  const partySeatsMap = {}, partyUsersMap = {};
  elected.forEach(c => {
    const pid = String(c.party || c.partyId || 'independent');
    partySeatsMap[pid] = (partySeatsMap[pid] || 0) + 1;
    (partyUsersMap[pid] = partyUsersMap[pid] || []).push(String(c.userId || c.user || ''));
  });
  const electedPartyIds = Object.keys(partySeatsMap);

  // 1. Carica TUTTI i partiti della nazione (array con dettagli completi)
  const allPartiesData = await loadPartiesForCountry(election.country || _currentCountryId);

  // 2. Mappa dettagli per accesso rapido (ora contiene TUTTI i partiti, non solo quelli eletti)
  const allPartyDetailsMap = {};
  allPartiesData.forEach(p => { allPartyDetailsMap[p._id] = p; });

  // 3. Voti per partito
  const partyVotesMap = {};
  election.candidates.forEach(c => {
    const pid = String(c.party || c.partyId || 'independent');
    const votes = election.votes ? (election.votes[String(c.userId || c.user)] || c.voteCount || 0) : (c.voteCount || 0);
    partyVotesMap[pid] = (partyVotesMap[pid] || 0) + votes;
  });

  // 4. Utenti (per leader e membri eletti)
  const allUserIds = new Set();
  elected.forEach(c => { if (c.userId || c.user) allUserIds.add(String(c.userId || c.user)); });
  Object.values(allPartyDetailsMap).forEach(pd => { if (pd?.leader) allUserIds.add(String(pd.leader)); });

  const userMap = {};
  for (const uid of allUserIds) {
    userMap[uid] = await localFetch('/user', { id: uid }).catch(() => ({}));
  }

  // 5. electedParties (partiti con seggi)
  const electedParties = electedPartyIds.map(pid => {
    if (!pid) {
      return { id: 'unknown', name: 'Unknown', abbr: 'N/A', seats: 0, members: 0, votes: 0, leaderName: null, leaderAvatarUrl: null, leaderId: null, color: '#6b7280', users: [] };
    }
    const color = getPartyColor(pid);
    if (pid === 'independent') {
      return {
        id: pid, name: 'Independent', abbr: 'IND', seats: partySeatsMap[pid], members: 0, votes: partyVotesMap[pid] || 0,
        leaderName: null, leaderAvatarUrl: null, leaderId: null, color,
        users: (partyUsersMap[pid] || []).map(uid => ({ userId: uid, ...userMap[uid] }))
      };
    }
    const pd = allPartyDetailsMap[pid] || {};
    const name = pd.name || _partyNamesMap.get(pid) || `Party ${pid.slice(-6)}` || 'Unknown Party';
    const leaderId = pd.leader ? String(pd.leader) : null;
    const leaderData = leaderId ? userMap[leaderId] : null;
    const rawMembers = Array.isArray(pd.members) ? pd.members.length : Number(pd.membersCount || pd.memberCount || 0);
    return {
      id: pid, name, abbr: makeAbbr(name),
      seats: partySeatsMap[pid], members: rawMembers, votes: partyVotesMap[pid] || 0,
      leaderName: leaderData?.username || null, leaderAvatarUrl: leaderData?.avatarUrl || null, leaderId,
      color,
      users: (partyUsersMap[pid] || []).map(uid => ({ userId: uid, ...userMap[uid] })),
    };
  }).sort((a, b) => b.seats - a.seats);

  // 6. allParties (TUTTI i partiti della nazione, con membri reali)
  const allParties = Object.keys(allPartyDetailsMap).map(pid => {
    const pd = allPartyDetailsMap[pid] || {};
    const color = getPartyColor(pid);
    const name = pd.name || _partyNamesMap.get(pid) || `Party ${pid.slice(-6)}` || 'Unknown Party';
    const rawMembers = Array.isArray(pd.members) ? pd.members.length : Number(pd.membersCount || pd.memberCount || 0);
    return { id: pid, name, abbr: makeAbbr(name), seats: partySeatsMap[pid] || 0, members: rawMembers, votes: partyVotesMap[pid] || 0, color };
  }).sort((a, b) => b.seats - a.seats || b.members - a.members);

  // 7. Mostra/nascondi il grafico "All parties"
  if (allParties.length > 0) {
    document.getElementById('allPartiesRow').style.display = '';
    renderAllPartiesChart(allParties);
  } else {
    document.getElementById('allPartiesRow').style.display = 'none';
  }

  const totalSeats = electedParties.reduce((s, p) => s + p.seats, 0);
  const majority = Math.floor(totalSeats / 2) + 1;

  fillStat('stat-seats', totalSeats);
  fillStat('stat-parties', electedParties.length);
  fillStat('stat-majority', majority);
  fillStat('stat-leader', electedParties[0]?.name || '—');
  // Effective Number of Parties (Laakso-Taagepera)
  const enp = (() => {
    const sumSq = electedParties.reduce((s, p) => {
      const share = p.seats / totalSeats;
      return s + share * share;
    }, 0);
    return sumSq > 0 ? (1 / sumSq).toFixed(2) : '—';
  })();
  fillStat('stat-enp', enp);
  const enpEl = document.getElementById('stat-enp-label');
  if (enpEl) {
    const v = parseFloat(enp);
    enpEl.textContent = v <= 2.5 ? 'Bipolar' : v <= 4 ? 'Multyparty' : 'Fragmented';
    enpEl.style.color = v <= 2.5 ? '#22c55e' : v <= 4 ? '#eab308' : '#ef4444';
  }

  await new Promise(resolve => requestAnimationFrame(resolve));
  hideSkeleton();

  Parliament.render({
    container: document.getElementById('parliamentContainer'),
    legendContainer: document.getElementById('legendContainer'),
    parties: electedParties,
    tooltip: document.getElementById('tooltip'),
  });

  renderPartyTable(electedParties, totalSeats);
  renderCharts(electedParties);
  updateTimelineHighlight();

  const badge = `${electedParties.length} parties · ${totalSeats} seats`;
  setStatus(badge, '');
  document.getElementById('badgeCount').textContent = badge;
  window._lastElectedParties = electedParties;
  window._lastAllParties = allParties;   // salva tutti i partiti per il simulatore
  electedParties.forEach(p => _partyNamesMap.set(p.id, p.name));

  // Preimposta l'expected voters con i voti totali dell'elezione corrente
const input = document.getElementById('simExpectedVotersInput');
if (input) {
  input.value = totalVotes || '';
}

  // Simulatore
  renderSimulator(allParties, totalSeats);   // passa allParties anziché electedParties
}

/* ══════════════════════════════════════════════════════════════
   ELECTORAL SIMULATOR
   ─ Historic turnout from real election data
   ─ User-adjustable expected turnout slider
   ─ Votes needed per seat / presidency
   ─ Per-party projection
══════════════════════════════════════════════════════════════ */
function renderSimulator(allParties, totalSeatsCurrent) {
  const panel = document.getElementById('simulatorPanel');
  if (!panel) return;

  const inputEl = document.getElementById('simExpectedVotersInput');
  const rawValue = inputEl?.value?.trim();
  let expectedVoters = parseInt(rawValue, 10);

  // Se il campo è vuoto o non è un numero valido → mostra il pannello ma senza risultati
  if (!rawValue || isNaN(expectedVoters) || expectedVoters <= 0) {
    panel.style.display = '';  // assicurati che sia visibile
    // Opzionale: mostra un messaggio invece della tabella
    const tbody = document.getElementById('simPartyBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text3);">Enter a valid number of expected voters</td></tr>';
    // Pulisci le metriche (o lascia i vecchi valori)
    document.getElementById('simExpVoters').textContent = '—';
    document.getElementById('simVotesPerSeat').textContent = '—';
    document.getElementById('simVotesToWin').textContent = '—';
    return; // ferma qui, ma pannello visibile
  }
  panel.style.display = '';

  // 1. Popolazione attiva
  const population = _currentCountryData?.rankings?.countryActivePopulation?.value || null;

 let dynamicSeats = null;
if (population) {
  dynamicSeats = Math.min(50, Math.floor(population / 20) + 2);
}
// Anche il fallback non deve mai superare 50
const MAX_SEATS = 50;
const totalSeats = dynamicSeats !== null 
  ? dynamicSeats 
  : Math.min(MAX_SEATS, totalSeatsCurrent);

  // Metriche
  const projVotesPerSeat = totalSeats > 0 ? Math.round(expectedVoters / totalSeats) : null;
  const votesToWinPres = Math.floor(expectedVoters / 2) + 1;

  // Mostra i valori nelle metriche
  document.getElementById('simPopulation').textContent = population ? population.toLocaleString() : '—';
  document.getElementById('simExpVoters').textContent = expectedVoters.toLocaleString();
  document.getElementById('simVotesPerSeat').textContent = projVotesPerSeat ? projVotesPerSeat.toLocaleString() : '—';
  document.getElementById('simVotesToWin').textContent = votesToWinPres ? votesToWinPres.toLocaleString() : '—';

  // Aggiungi una nuova metrica per i seggi calcolati (la puoi anche sostituire a "Avg votes")
  // Per ora riutilizzo l'elemento 'simAvgVotes' per mostrare i seggi dinamici
  // (modifica l'HTML se preferisci un elemento dedicato)
const seggiEl = document.getElementById('simAvgVotes');
if (seggiEl) {
  const note = dynamicSeats ? ' (calc)' : (totalSeatsCurrent > MAX_SEATS ? ' (capped)' : ' (from election)');
  seggiEl.textContent = totalSeats + note;
  seggiEl.style.fontSize = '1.1rem';
}
  // Sottoetichetta (simAvgTurnout) come "max 50" o "based on pop"
const seggiSubEl = document.getElementById('simAvgTurnout');
if (seggiSubEl) {
  if (dynamicSeats) {
    seggiSubEl.textContent = `max 50 · pop/20+2`;
  } else if (totalSeatsCurrent > MAX_SEATS) {
    seggiSubEl.textContent = `election had ${totalSeatsCurrent}, capped at 50`;
  } else {
    seggiSubEl.textContent = 'current election';
  }
}

  // Chip storico (invariato)
  const congressElections = _electionHistory.filter(e => e.type === 'congress');
  const recentTurnouts = congressElections.slice(-6).map(e => ({
    electionId: e._id,
    totalVotes: e.votesCount || 0,
    date: e.createdAt,
    seats: (e.candidates || []).filter(c => c.isElected).length
  }));
  const avgVotes = recentTurnouts.length
    ? Math.round(recentTurnouts.reduce((s, t) => s + t.totalVotes, 0) / recentTurnouts.length)
    : null;
  const refEl = document.getElementById('simHistoricRef');
  if (refEl) {
    if (recentTurnouts.length === 0) {
      refEl.innerHTML = '<span style="color:var(--text3);font-size:.72rem;">No historical data yet</span>';
    } else {
      refEl.innerHTML = recentTurnouts.map((t, i) => {
        const d = t.date ? new Date(t.date).toLocaleDateString('en', { month: 'short', year: '2-digit' }) : `#${i + 1}`;
        const pct = population ? ((t.totalVotes / population) * 100).toFixed(0) + '%' : t.totalVotes.toLocaleString() + ' v';
        const isLast = i === recentTurnouts.length - 1;
        return `<span class="sim-chip${isLast ? ' sim-chip-latest' : ''}" title="Election ${d}: ${t.totalVotes.toLocaleString()} votes">${d} · ${pct}</span>`;
      }).join('');
    }
  }

  // Tabella partiti (basata sui membri)
  const tbody = document.getElementById('simPartyBody');
  if (tbody) {
    const totalMembers = allParties.reduce((s, p) => s + (p.members || 0), 0);
    if (totalMembers === 0) {
      tbody.innerHTML = '<tr><td colspan="6">No member data available</td></tr>';
    } else {
      tbody.innerHTML = allParties.map(p => {
        const memberShare = (p.members || 0) / totalMembers;
        const projVotes = Math.round(expectedVoters * memberShare);
        const projSeats = projVotesPerSeat && projVotesPerSeat > 0
          ? Math.round(projVotes / projVotesPerSeat)
          : 0;
        const delta = projSeats - (p.seats || 0);
        const deltaStr = delta === 0 ? '=' : (delta > 0 ? `+${delta}` : `${delta}`);
        const deltaColor = delta > 0 ? '#22c55e' : delta < 0 ? '#ef4444' : '#535e72';
        const sharePct = (memberShare * 100).toFixed(1);
        return `<tr>
          <td><span class="party-color-bar" style="background:${p.color};display:inline-block;width:3px;height:16px;border-radius:2px;margin-right:6px;vertical-align:middle;"></span>${p.name}</td>
          <td style="color:var(--text2)">${sharePct}% (member)</td>
          <td>${projVotes.toLocaleString()}</td>
          <td>${p.seats || 0}</td>
          <td style="font-weight:600;color:${deltaColor}">${deltaStr}</td>
          <td style="font-weight:600">${projSeats}</td>
        </tr>`;
      }).join('');
    }
  }
}

function onExpectedVotersChange() {
  if (window._lastAllParties) {
    const totalSeats = window._lastAllParties.reduce((s, p) => s + (p.seats || 0), 0);
    renderSimulator(window._lastAllParties, totalSeats);
  }
}

/* ── MAIN ENTRY ── */
async function loadElection(id) {
  const electionId = id || document.getElementById('electionIdInput').value.trim();
  if (!electionId) { setStatus('Enter an election ID', 'error'); return; }

  if (_pendingRequest) {
    clearTimeout(_pendingRequest.timeout);
    if (_pendingRequest.controller) _pendingRequest.controller.abort();
  }
  const selectEl = document.getElementById('electionSelect');
  const inputEl = document.getElementById('electionIdInput');
  const btnEl = document.getElementById('loadBtn');
  selectEl.disabled = true; inputEl.disabled = true; btnEl.disabled = true;

  _pendingRequest = {};
  _pendingRequest.timeout = setTimeout(async () => {
    _pendingRequest = null;
    setStatus('Loading election...', 'loading');

    try {
      const controller = new AbortController();
      _pendingRequest = { controller };

      const election = await localFetch('/election', { id: electionId });
      if (!election || !election.candidates) {
        // Invece di lanciare errore, mostra un messaggio e nascondi la vista
        console.warn('No detail for this ID:', electionId);
        showView('congress'); // o nascondi entrambe?
        hideSkeleton();
        setStatus('⚠️ Election not foun or incomplete.', 'error');
        return;
      }

      if (election.type === 'president') await loadPresidentialElection(election);
      else if (election.type === 'congress') await loadCongressElection(election);
      else throw new Error(`Unknown election type: ${election.type}`);

      setStatus('Updated Data', '');

      // Traccia il caricamento elezione su Umami
      if (window.umami) {
        window.umami.track('election-load', {
          electionId: election._id,
          type: election.type,
          countryId: election.country || _currentCountryId
        });
      }
    } catch (err) {
      console.error(err);
      hideSkeleton();
      if (err.message.includes('429')) {
        setStatus('⚠️ Too mani request! Retry after some seconds.', 'error');
      } else if (err.name !== 'AbortError') {
        setStatus('Errore: ' + err.message, 'error');
      }
    } finally {
      selectEl.disabled = false; inputEl.disabled = false; btnEl.disabled = false;
    }
  }, 300);
}

/* ── BOOT ── */
/* ── BOOT ── */
document.addEventListener('DOMContentLoaded', () => {
  // 1. Carica i colori dal CSV globale
  loadPartyColors('parties_6813b6d446e731854c7ac7a2.csv').then(async () => {
    console.log(`🎨 ${_partyColorMap.size} colors loaded from CSV`);
    loadCountries();

    // 🔁 Recupera i dati della nazione predefinita (Italia)
    try {
      const data = await localFetch('/countries', {}, { useCache: false });
      _currentCountryData = (data?.items || []).find(c => c._id === _currentCountryId) || null;
    } catch (_) {
      _currentCountryData = null;
    }

    loadElectionsHistory();
  });

  // 2. Listener cambio nazione
  document.getElementById('countrySelect').addEventListener('change', async function () {
    const newCountryId = this.value;
    if (newCountryId === _currentCountryId) return;

    _currentCountryId = newCountryId;
    _electionHistory = [];
    _currentCongressElectionId = null;
    _partyColorMap.clear();       // opzionale ma consigliato
    _partyNamesMap.clear();
    // Recupera i dati del paese (popolazione attiva, etc.)
    try {
      const data = await localFetch('/countries', {}, { useCache: false });
      _currentCountryData = (data?.items || []).find(c => c._id === newCountryId) || null;
    } catch (_) {
      _currentCountryData = null;
    }


    setStatus('Loading…', 'loading');

    try {
      await loadPartiesForCountry(_currentCountryId);
      await loadElectionsHistory();

      if (window.umami) {
        window.umami.track('country-change', { country: _currentCountryId });
      }
    } catch (err) {
      console.error('Error switching country:', err);
      setStatus('Error loading data', 'error');
    }
  });

  // 3. Listener per il caricamento elezioni
  document.getElementById('loadBtn').addEventListener('click', () => loadElection());
  document.getElementById('electionIdInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') loadElection();
  });
  document.getElementById('electionSelect').addEventListener('change', function () {
    if (this.value) {
      document.getElementById('electionIdInput').value = this.value;
      loadElection(this.value);
    }
  });

  // 4. Listener per export / fullscreen (una volta sola)
  document.getElementById('exportCsvBtn')?.addEventListener('click', () => exportCSV(window._lastElectedParties));
  document.getElementById('fullscreenBtn')?.addEventListener('click', openParliamentFullscreen);
  // 5. Simulator slider
  document.getElementById('simExpectedVotersInput')?.addEventListener('input', onExpectedVotersChange);
  document.getElementById('overlayClose')?.addEventListener('click', closeParliamentFullscreen);
  document.getElementById('parliamentOverlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('parliamentOverlay')) closeParliamentFullscreen();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeParliamentFullscreen();
  });

  // 5. Clear cache
  document.getElementById('clearCacheBtn')?.addEventListener('click', () => {
    cacheClear();
    setStatus('Cache cleared', '');
    setTimeout(() => setStatus('', ''), 2000);
  });
});