const API_BASE = 'http://37.77.140.194:3000/api';
const APP_BASE = 'https://app.warera.io';

const PALETTE = [
  '#3b82f6', '#22c55e', '#eab308', '#ef4444', '#a855f7',
  '#f97316', '#06b6d4', '#ec4899', '#84cc16', '#f43f5e',
  '#6366f1', '#14b8a6', '#d946ef', '#0ea5e9', '#f59e0b',
];

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
let _partyNamesMap = new Map();
let _seatsChart, _membersChart, _allPartiesChart, _presidentChart, _timelineChart;
let _apiKey = sessionStorage.getItem('we_key') || '';
let _pendingRequest = null;
let _electionHistory = [];
let _currentCongressElectionId = null;
let _timelineElectionIds = [];
let _currentCountryId = '6813b6d446e731854c7ac7a2';

/* ── ABBR INTELLIGENTE ── */
function makeAbbr(name) {
  if (!name) return '???';
  const stop = new Set(['il', 'lo', 'la', 'le', 'gli', 'i', 'di', 'del', 'della', 'dei', 'delle', 'degli', 'del', 'in', 'per', 'e', 'a', 'da', 'su', 'con', 'tra', 'fra', 'o', 'un', 'una']);
  const words = name.replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 0);
  const sig = words.filter(w => !stop.has(w.toLowerCase()));
  const src = sig.length > 0 ? sig : words;
  if (src.length >= 3) return (src[0][0] + src[1][0] + src[2][0]).toUpperCase();
  if (src.length === 2) return (src[0].substring(0, 2) + src[1][0]).toUpperCase();
  return src[0].substring(0, 3).toUpperCase();
}

/* ── FETCH VERSO IL SERVER LOCALE ── */
async function localFetch(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}${qs ? '?' + qs : ''}`;
  const headers = _apiKey ? { Authorization: `Bearer ${_apiKey}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} → ${path}`);
  return await res.json();
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
  ['stat-seats', 'stat-parties', 'stat-elected', 'stat-majority', 'stat-leader'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = '—';
    el.classList.add('skeleton-val');
    el.classList.remove('loaded');
  });
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
  // --------------------------------------------------------

  const datasets = [];
  const legendDiv = document.getElementById('timelineLegend');
  legendDiv.innerHTML = '';

  let colorIdx = 0;
  for (const pid of allPids) {
    if (pid === 'independent') continue;
    const color = _partyColorMap.get(pid) || PALETTE[colorIdx % PALETTE.length];
    const name  = _partyNamesMap.get(pid) || pid.slice(-6);   // ora dovrebbe esserci
    const data  = partySeatsPerElection.map(m => m[pid] || 0);
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
      const movingAvg = data.map((v, i) => (i === 0) ? v : Math.round((data[i-1] + data[i]) / 2));
      datasets.push({
        label: '',
        data: movingAvg,
        borderColor: color,
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [4, 3],
        pointRadius: 0,
        pointHoverRadius: 0,
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
        backgroundColor: sorted.map(p => p.seats > 0 ? p.color + 'cc' : 'rgba(255,255,255,0.06)'),
        borderColor: sorted.map(p => p.seats > 0 ? p.color : 'rgba(255,255,255,0.10)'),
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

/* ── PRESIDENTIAL ── */
function renderPresidentialTurnoutChart(currentElectionId = null) {
  const presidentialElections = _electionHistory
    .filter(e => e.type === 'president')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (presidentialElections.length < 2) return;

  const canvas = document.getElementById('presidentTurnoutChart');
  if (!canvas) return;
  const existing = Chart.getChart(canvas);
  if (existing) existing.destroy();

  const labels = presidentialElections.map(e => new Date(e.createdAt).toLocaleDateString('it', { month: 'short', year: '2-digit' }));
  const data = presidentialElections.map(e => e.votesCount || 0);
  const electionIds = presidentialElections.map(e => e._id);

  const pointRadii = presidentialElections.map(e => (currentElectionId && e._id === currentElectionId) ? 8 : 4);
  const movingAverage = data.map((v, i) => (i === 0) ? v : Math.round((data[i - 1] + data[i]) / 2));

  new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Voti totali', data, borderColor: '#e8c97a', backgroundColor: 'rgba(232,201,122,0.1)', borderWidth: 2, pointRadius: pointRadii, pointHoverRadius: pointRadii.map(r => r + 2), pointBackgroundColor: '#e8c97a', tension: 0.3, fill: true },
        { label: 'Media mobile (2)', data: movingAverage, borderColor: '#60a5fa', backgroundColor: 'transparent', borderWidth: 2, borderDash: [6, 3], pointRadius: 0, pointHoverRadius: 3, tension: 0.3, fill: false },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f1521', borderColor: 'rgba(197,150,74,.3)', borderWidth: 1,
          titleColor: '#e8c97a', bodyColor: '#8892a4', padding: 10, cornerRadius: 6,
          callbacks: { title: items => `Elezione ${items[0].label}`, label: item => ` ${item.dataset.label}: ${item.parsed.y.toLocaleString()} voti` }
        }
      },
      scales: {
        x: { ticks: { color: '#535e72', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.035)' }, border: { color: 'rgba(255,255,255,0.06)' } },
        y: { beginAtZero: true, ticks: { color: '#535e72', callback: v => v.toLocaleString() }, grid: { color: 'rgba(255,255,255,0.035)' }, border: { color: 'rgba(255,255,255,0.06)' } }
      },
      onClick: (evt, elements) => { if (elements.length) { const idx = elements[0].index; const eid = electionIds[idx]; if (eid) { document.getElementById('electionSelect').value = eid; document.getElementById('electionIdInput').value = eid; loadElection(eid); } } }
    }
  });
}

async function loadPresidentialElection(election) {
  document.getElementById('timelinePanel').style.display = 'none';
  showView('president');
  resetStats();
  fillStat('stat-elected', election.candidates?.length ?? '—');

  const candidates = [];
  for (const c of election.candidates) {
    const userData = await localFetch('/user', { id: c.user || c.userId });
    const votes = election.votes ? (election.votes[String(c.user || c.userId)] ?? c.voteCount ?? 0) : (c.voteCount ?? 0);
    candidates.push({ ...c, userData, votes, color: PALETTE[candidates.length % PALETTE.length] });
  }
  candidates.sort((a, b) => b.votes - a.votes);

  const totalVotes = election.votesCount || candidates.reduce((s, c) => s + c.votes, 0);
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
  fillStat('stat-elected', candidates.length);
}

/* ── CONGRESS ELECTION ── */
async function loadCongressElection(election) {
  document.getElementById('timelinePanel').style.display = '';
  showView('congress');
  _currentCongressElectionId = election._id;
  showSkeleton();
  resetStats();

  const elected = election.candidates.filter(c => c.isElected);
  if (!elected.length) throw new Error('Nessun candidato eletto trovato.');

  const partySeatsMap = {}, partyUsersMap = {};
  elected.forEach(c => {
    const pid = String(c.party || c.partyId || 'independent');
    partySeatsMap[pid] = (partySeatsMap[pid] || 0) + 1;
    (partyUsersMap[pid] = partyUsersMap[pid] || []).push(String(c.userId || c.user || ''));
  });
  const electedPartyIds = Object.keys(partySeatsMap);

  const partyVotesMap = {};
  election.candidates.forEach(c => {
    const pid = String(c.party || c.partyId || 'independent');
    const votes = election.votes ? (election.votes[String(c.userId || c.user)] || c.voteCount || 0) : (c.voteCount || 0);
    partyVotesMap[pid] = (partyVotesMap[pid] || 0) + votes;
  });

  const allPartyDetailsMap = {};
  await Promise.all(electedPartyIds.map(pid => localFetch('/party', { id: pid }).then(p => { allPartyDetailsMap[pid] = p; })));

  const allCsvIds = [..._partyColorMap.keys()];
  const nonElectedCsvIds = allCsvIds.filter(id => !electedPartyIds.includes(id) && id !== 'independent');
  if (nonElectedCsvIds.length > 0) {
    setStatus(`Recupero ${nonElectedCsvIds.length} partiti dal CSV…`, 'loading');
    await Promise.all(nonElectedCsvIds.map(pid => localFetch('/party', { id: pid }).then(p => { allPartyDetailsMap[pid] = p; })));
  }

  const allUserIds = new Set();
  elected.forEach(c => { if (c.userId || c.user) allUserIds.add(String(c.userId || c.user)); });
  Object.values(allPartyDetailsMap).forEach(pd => { if (pd?.leader) allUserIds.add(String(pd.leader)); });

  const userMap = {};
  for (const uid of allUserIds) { userMap[uid] = await localFetch('/user', { id: uid }); }

  const electedParties = electedPartyIds.map(pid => {
    const color = _partyColorMap.get(pid) || PALETTE[electedPartyIds.indexOf(pid) % PALETTE.length];
    if (pid === 'independent') {
      return {
        id: pid, name: 'Indipendente', abbr: 'IND', seats: partySeatsMap[pid], members: 0, votes: partyVotesMap[pid] || 0, leaderName: null, leaderAvatarUrl: null, leaderId: null, color: '#6b7280',
        users: (partyUsersMap[pid] || []).map(uid => ({ userId: uid, ...userMap[uid] }))
      };
    }
    const pd = allPartyDetailsMap[pid] || {};
    const name = pd.name || _partyNamesMap.get(pid) || `Partito ${pid.slice(-6)}`;
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

  const allPartyIds = [...new Set([...allCsvIds, ...electedPartyIds])];
  const allParties = allPartyIds.map(pid => {
    const color = _partyColorMap.get(pid) || '#6b7280';
    const pd = allPartyDetailsMap[pid] || {};
    const name = pd.name || _partyNamesMap.get(pid) || (pid === 'independent' ? 'Indipendente' : `Partito ${pid.slice(-6)}`);
    const rawMembers = Array.isArray(pd.members) ? pd.members.length : Number(pd.membersCount || pd.memberCount || 0);
    return { id: pid, name, abbr: makeAbbr(name), seats: partySeatsMap[pid] || 0, members: rawMembers, votes: partyVotesMap[pid] || 0, color };
  }).sort((a, b) => b.seats - a.seats || b.members - a.members);

  if (_partyColorMap.size > 0) {
    document.getElementById('allPartiesRow').style.display = '';
    renderAllPartiesChart(allParties);
  } else {
    document.getElementById('allPartiesRow').style.display = 'none';
  }

  const totalSeats = electedParties.reduce((s, p) => s + p.seats, 0);
  const majority = Math.floor(totalSeats / 2) + 1;

  fillStat('stat-seats', totalSeats);
  fillStat('stat-parties', electedParties.length);
  fillStat('stat-elected', elected.length);
  fillStat('stat-majority', majority);
  fillStat('stat-leader', electedParties[0]?.name || '—');

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

  const badge = `${electedParties.length} partiti · ${totalSeats} seggi`;
  setStatus(badge, '');
  document.getElementById('badgeCount').textContent = badge;

  electedParties.forEach(p => _partyNamesMap.set(p.id, p.name));
}

/* ── MAIN ENTRY ── */
async function loadElection(id) {
  const electionId = id || document.getElementById('electionIdInput').value.trim();
  if (!electionId) { setStatus('Inserisci un ID elezione', 'error'); return; }

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
    setStatus('Caricamento elezione…', 'loading');

    try {
      const controller = new AbortController();
      _pendingRequest = { controller };

      const election = await localFetch('/election', { id: electionId });
      if (!election?.candidates) throw new Error('Dati elezione mancanti.');

      if (election.type === 'president') await loadPresidentialElection(election);
      else if (election.type === 'congress') await loadCongressElection(election);
      else throw new Error(`Tipo sconosciuto: ${election.type}`);

      setStatus('Dati aggiornati', '');
    } catch (err) {
      console.error(err);
      hideSkeleton();
      if (err.message.includes('429')) setStatus('⚠️ Troppe richieste! Riprova tra qualche secondo.', 'error');
      else if (err.name !== 'AbortError') setStatus('Errore: ' + err.message, 'error');
    } finally {
      selectEl.disabled = false; inputEl.disabled = false; btnEl.disabled = false;
    }
  }, 300);
}

/* ── BOOT ── */
document.addEventListener('DOMContentLoaded', () => {
  // 1. Carica la lista delle nazioni
  loadCountries();

  // 2. Quando l'utente cambia nazione, ricarica tutto
  document.getElementById('countrySelect').addEventListener('change', async function () {
    const newCountryId = this.value;
    if (newCountryId === _currentCountryId) return;

    _currentCountryId = newCountryId;

    _electionHistory = [];
    _currentCongressElectionId = null;
    _partyColorMap.clear();
    _partyNamesMap.clear();

    setStatus('Loading…', 'loading');

    try {
      await loadElectionsHistory();
    } catch (err) {
      console.error('Error switching country:', err);
      setStatus('Error loading data', 'error');
    }
  });

  // 3. Avvia il caricamento iniziale (Italia di default)
  loadElectionsHistory();

  // 4. Altri listener
  document.getElementById('loadBtn').addEventListener('click', () => loadElection());
  document.getElementById('electionIdInput').addEventListener('keydown', e => { if (e.key === 'Enter') loadElection(); });
  document.getElementById('electionSelect').addEventListener('change', function () {
    if (this.value) {
      document.getElementById('electionIdInput').value = this.value;
      loadElection(this.value);
    }
  });
});