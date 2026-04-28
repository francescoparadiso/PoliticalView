const API2 = 'https://api2.warera.io/trpc';
const API5 = 'https://api5.warera.io/trpc';
const APP_BASE = 'https://app.warera.io';

const PALETTE = [
  '#3b82f6','#22c55e','#eab308','#ef4444','#a855f7',
  '#f97316','#06b6d4','#ec4899','#84cc16','#f43f5e',
  '#6366f1','#14b8a6','#d946ef','#0ea5e9','#f59e0b',
];

const ALL_PARTY_IDS = [
  '69ef93ec8ab2a4aefe49095b','69e72e6cc830caae56466385','69d58550aa2c2516cb8b3903',
  '69d1239878dfd418157901cb','69bf4483f43e5ce727ce8d5f','698d65eb59a9c1e30d457eb4',
  '698d08553e60459e0833a4db','698d017eebb98b9142fa280d','698cfc8c842d2f3f58663199',
];

let _seatsChart, _membersChart, _allPartiesChart, _presidentChart;
let _apiKey = sessionStorage.getItem('we_key') || '';
let _pendingRequest = null;

/* ── API ── */
async function trpcPost(base, proc, input, signal) {
  const res = await fetch(`${base}/${proc}?batch=1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(_apiKey && { Authorization: `Bearer ${_apiKey}` }),
    },
    body: JSON.stringify({ 0: input }),
    signal,  // ← aggiunto
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} → ${proc}`);
  const j = await res.json();
  if (Array.isArray(j)) { const d = j[0]?.result?.data; return d !== undefined ? d : j[0]?.result ?? j[0]; }
  return j?.result?.data ?? j;
}

async function trpcGet(base, proc, input) {
  const res = await fetch(`${base}/${proc}?input=${encodeURIComponent(JSON.stringify(input))}`, {
    headers: _apiKey ? { Authorization:`Bearer ${_apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} → ${proc}`);
  const j = await res.json();
  if (Array.isArray(j)) return j[0]?.result?.data;
  return j?.result?.data ?? j;
}

async function fetchUsersSequential(userIds) {
  const map = {};
  for (const uid of [...new Set(userIds.map(String))]) {
    try {
      const u = await trpcGet(API2, 'user.getUserLite', { userId: uid });
      map[uid] = { username: u?.username || `#${uid.slice(-6)}`, avatarUrl: u?.avatarUrl || null };
    } catch (_) { map[uid] = { username:`#${uid.slice(-6)}`, avatarUrl:null }; }
  }
  return map;
}

/* ── HELPERS ── */
function setStatus(msg, type='') {
  const el = document.getElementById('statusBadge');
  el.textContent = msg; el.className = 'badge-status ' + type;
}
function fillStat(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

function safeDestroy(canvasId) {
  const existing = Chart.getChart(canvasId);
  if (existing) existing.destroy();
}

function showView(which) {
  document.getElementById('president-view').style.display  = which === 'president'  ? '' : 'none';
  document.getElementById('congress-view').style.display   = which === 'congress'   ? '' : 'none';
}

/* ── STORICO ELEZIONI ── */
async function loadElectionsHistory() {
  try {
    const data = await trpcGet(API5, 'election.getElections', { countryId: '6813b6d446e731854c7ac7a2' });
    const items = data?.items || data?.results || [];
    const select = document.getElementById('electionSelect');
    
    // Pulisci opzioni tranne la prima
    while (select.options.length > 1) select.remove(1);
    
    // Ordina per data decrescente
    items.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    items.forEach(election => {
      const opt = document.createElement('option');
      opt.value = election._id;
      const typeEmoji = election.type === 'president' ? '👤' : '🏛️';
      const date = new Date(election.createdAt).toLocaleDateString('it');
      opt.textContent = `${typeEmoji} ${election.type === 'president' ? 'Presidenziale' : 'Congresso'} · ${date}`;
      select.appendChild(opt);
    });

    // Seleziona automaticamente la prima elezione (la più recente)
    if (items.length > 0) {
      const latestElection = items[0];
      // Imposta il dropdown
      select.value = latestElection._id;
      // Aggiorna anche l'input manuale
      document.getElementById('electionIdInput').value = latestElection._id;
      // Carica i dati
      await loadElection(latestElection._id);
    }
  } catch (err) {
    console.warn('Storico elezioni non disponibile:', err.message);
  }
}

/* ── CONGRESS: party table + charts ── */
function renderPartyTable(electedParties, totalSeats) {
  const sorted = [...electedParties].sort((a,b) => b.seats - a.seats);
  document.getElementById('partyTableBody').innerHTML = sorted.map(p => {
    const pct  = totalSeats ? ((p.seats/totalSeats)*100).toFixed(1) : 0;
    const barW = totalSeats ? (p.seats/totalSeats*100).toFixed(1)   : 0;
    const leaderAvatar = p.leaderAvatarUrl
      ? `<img src="${p.leaderAvatarUrl}" class="avatar-small" alt="">`
      : `<span class="avatar-placeholder">👤</span>`;
    const leaderEl = p.leaderId
      ? `<a href="${APP_BASE}/user/${p.leaderId}" target="_blank" class="leader-link">${leaderAvatar} ${p.leaderName||'—'}</a>`
      : `<span class="leader-chip">${leaderAvatar} ${p.leaderName||'—'}</span>`;
    return `<tr>
      <td><div class="party-name-cell"><span class="party-color-bar" style="background:${p.color}"></span><span>${p.name}</span></div></td>
      <td><div class="seats-bar-wrap"><div class="seats-bar"><div class="seats-bar-fill" style="width:${barW}%;background:${p.color}"></div></div><span class="seats-num">${p.seats}</span></div></td>
      <td>${p.members}</td>
      <td><span class="party-pct">${pct}%</span></td>
      <td>${leaderEl}</td>
    </tr>`;
  }).join('');
}

function renderCharts(electedParties) {
  safeDestroy('seatsChart');
  safeDestroy('membersChart');
  if (!electedParties.length) return;

  const colors  = electedParties.map(p => p.color);
  const colorsA = colors.map(c => c+'cc');
  const tt = { backgroundColor:'#0f1521', borderColor:'rgba(197,150,74,.3)', borderWidth:1,
    titleColor:'#e8c97a', bodyColor:'#8892a4', padding:10, cornerRadius:6 };

// Nuova configurazione per il grafico a mezza torta
_seatsChart = new Chart(document.getElementById('seatsChart').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: electedParties.map(p => p.name),
      datasets: [{
        data: electedParties.map(p => p.seats),
        backgroundColor: colorsA,
        borderColor: '#0e1117',
        borderWidth: 3,
        hoverBorderColor: colors,
        hoverBorderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',               // Manteniamo l'effetto "ciambella"
      rotation: -90,              // Inizia da sinistra (-180°)
      circumference: 180,          // Disegna solo 180° (metà torta)
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
            title: (items) => items[0].label,
            label: (item) => {
              const total = electedParties.reduce((s, p) => s + p.seats, 0);
              const v = Number(item.raw);
              return ` ${v} seggi (${((v / total) * 100).toFixed(1)}%)`;
            }
          }
        }
      },
      onClick: (event, elements) => {
        if (elements.length > 0) {
          const i = elements[0].index;
          window.open(`${APP_BASE}/party/${electedParties[i].id}`, '_blank');
        }
      }
    },
});

  _membersChart = new Chart(document.getElementById('membersChart').getContext('2d'), {
    type:'bar',
    data: { labels:electedParties.map(p=>p.abbr||p.name), datasets:[{
      data:electedParties.map(p=>Number(p.members)||0), backgroundColor:colorsA,
      borderColor:colors, borderWidth:1.5, borderRadius:5, borderSkipped:false,
    }]},
    options: { responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{...tt, callbacks:{
        title: i => electedParties[i[0].dataIndex].name,
        label: i => `${i.raw} iscritti`,
      }}},
      scales:{
        y:{ beginAtZero:true, ticks:{color:'#535e72'}, grid:{color:'rgba(255,255,255,0.035)'} },
        x:{ ticks:{color:'#8892a4',font:{size:11}}, grid:{display:false} }
      },
      onClick: (_,el) => { if(el.length) window.open(`${APP_BASE}/party/${electedParties[el[0].index].id}`,'_blank'); }
    },
  });
}

function renderAllPartiesChart(allParties) {
  safeDestroy('allPartiesChart');
  if (!allParties.length) return;
  const sorted = [...allParties].sort((a,b) => b.members-a.members);
  const tt = { backgroundColor:'#0f1521', borderColor:'rgba(197,150,74,.3)', borderWidth:1,
    titleColor:'#e8c97a', bodyColor:'#8892a4', padding:10, cornerRadius:6 };

  _allPartiesChart = new Chart(document.getElementById('allPartiesChart').getContext('2d'), {
    type:'bar',
    data:{ labels:sorted.map(p=>p.abbr||p.name), datasets:[{
      data:sorted.map(p=>Number(p.members)||0),
      backgroundColor:sorted.map(p=>p.seats>0 ? p.color+'cc' : p.color+'33'),
      borderColor:sorted.map(p=>p.seats>0 ? p.color : p.color+'66'),
      borderWidth:1.5, borderRadius:5, borderSkipped:false,
    }]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{...tt, callbacks:{
        title: i => String(sorted[i[0].dataIndex].name),
        label: i => { const p=sorted[i.dataIndex]; return `${i.raw} membri${p.seats>0?` · ${p.seats} seggi`:' · nessun seggio'}`; }
      }}},
      scales:{
        y:{ beginAtZero:true, ticks:{color:'#535e72'}, grid:{color:'rgba(255,255,255,0.035)'} },
        x:{ ticks:{color:'#8892a4',font:{size:10}}, grid:{display:false} }
      },
      onClick:(_,el)=>{ if(el.length) window.open(`${APP_BASE}/party/${sorted[el[0].index].id}`,'_blank'); }
    },
  });
  document.getElementById('badgeAllParties').textContent = `${allParties.length} partiti`;
}

/* ══════════════════════════════════════════════
   PRESIDENTIAL VIEW
══════════════════════════════════════════════ */
async function loadPresidentialElection(election) {
  showView('president');

  fillStat('stat-seats',    '—');
  fillStat('stat-parties',  '—');
  fillStat('stat-elected',  election.candidates?.length ?? '—');
  fillStat('stat-majority', '—');
  fillStat('stat-leader',   '—');

  const candidates = [];
  for (const c of election.candidates) {
    let userData = { username:`#${String(c.user||c.userId||'').slice(-6)}`, avatarUrl:null };
    try {
      const u = await trpcGet(API2, 'user.getUserLite', { userId: String(c.user||c.userId) });
      if (u) userData = { username: u.username || userData.username, avatarUrl: u.avatarUrl || null };
    } catch (_) {}
    const votes = election.votes
      ? (election.votes[String(c.user||c.userId)] ?? c.voteCount ?? 0)
      : (c.voteCount ?? 0);
    candidates.push({ ...c, userData, votes, color: PALETTE[candidates.length % PALETTE.length] });
  }
  candidates.sort((a,b) => b.votes - a.votes);

  const totalVotes = election.votesCount || candidates.reduce((s,c) => s+c.votes, 0);
  const winner     = candidates.find(c => c.isElected) || candidates[0];
  const maxVotes   = candidates[0]?.votes || 1;

  const now = new Date(), end = new Date(election.votesEndAt), start = new Date(election.votesStartAt);
  let statusText = '', statusClass = '';
  if (now < start)       { statusText = '🗳 Candidatura'; statusClass = 'pres-badge-pending'; }
  else if (now <= end)   { statusText = '🔴 Votazione in corso'; statusClass = 'pres-badge-live'; }
  else                   { statusText = '✅ Conclusa'; statusClass = 'pres-badge-done'; }
  const presStatusBadge = document.getElementById('pres-status-badge');
  presStatusBadge.textContent = statusText;
  presStatusBadge.className   = 'badge-count ' + statusClass;

  const banner = document.getElementById('pres-winner-banner');
  if (winner && now > end) {
    const av = winner.userData.avatarUrl
      ? `<img src="${winner.userData.avatarUrl}" class="pres-winner-avatar" alt="">`
      : `<div class="pres-winner-avatar pres-winner-initials">${winner.userData.username[0].toUpperCase()}</div>`;
    banner.style.display = '';
    banner.innerHTML = `
      <div class="pres-winner-left">
        ${av}
        <div>
          <div class="pres-winner-label">🏆 Presidente eletto</div>
          <div class="pres-winner-name">${winner.userData.username}</div>
        </div>
      </div>
      <div class="pres-winner-votes">
        <div class="pres-winner-vcount">${winner.votes}</div>
        <div class="pres-winner-vsub">voti · ${totalVotes ? ((winner.votes/totalVotes)*100).toFixed(1)+'%' : '—'}</div>
      </div>`;
    fillStat('stat-leader', winner.userData.username);
  } else {
    banner.style.display = 'none';
  }

  const race = document.getElementById('pres-race');
  race.innerHTML = candidates.map((c, i) => {
    const pct     = totalVotes ? ((c.votes/totalVotes)*100).toFixed(1) : 0;
    const barW    = maxVotes   ? ((c.votes/maxVotes)*100).toFixed(1)   : 0;
    const isWin   = c.isElected;
    const av      = c.userData.avatarUrl
      ? `<img src="${c.userData.avatarUrl}" class="race-avatar" alt="">`
      : `<div class="race-avatar race-initials" style="background:${c.color}33;color:${c.color}">${c.userData.username[0].toUpperCase()}</div>`;
    return `
    <div class="race-row${isWin ? ' race-winner' : ''}">
      <div class="race-rank">${i+1}</div>
      ${av}
      <div class="race-info">
        <div class="race-name">${c.userData.username}${isWin ? ' <span class="race-win-chip">Eletto</span>':''}</div>
        <div class="race-bar-wrap">
          <div class="race-bar" style="width:${barW}%;background:${c.color}"></div>
        </div>
      </div>
      <div class="race-stats">
        <div class="race-votes">${c.votes.toLocaleString()}</div>
        <div class="race-pct">${pct}%</div>
      </div>
    </div>`;
  }).join('');

  safeDestroy('presidentChart');
  _presidentChart = new Chart(document.getElementById('presidentChart').getContext('2d'), {
    type:'bar',
    data:{
      labels: candidates.map(c=>c.userData.username),
      datasets:[{
        data: candidates.map(c=>c.votes),
        backgroundColor: candidates.map(c=>c.color+'cc'),
        borderColor:     candidates.map(c=>c.color),
        borderWidth:1.5, borderRadius:6, borderSkipped:false,
      }],
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{
        legend:{display:false},
        tooltip:{
          backgroundColor:'#0f1521', borderColor:'rgba(197,150,74,.3)', borderWidth:1,
          titleColor:'#e8c97a', bodyColor:'#8892a4', padding:10, cornerRadius:6,
          callbacks:{
            title: i => candidates[i[0].dataIndex].userData.username,
            label: i => ` ${i.raw.toLocaleString()} voti (${totalVotes?((i.raw/totalVotes)*100).toFixed(1)+'%':'—'})`,
          }
        }
      },
      scales:{
        y:{ beginAtZero:true, ticks:{color:'#535e72'}, grid:{color:'rgba(255,255,255,0.035)'} },
        x:{ ticks:{color:'#8892a4'}, grid:{display:false} },
      },
    },
  });

  document.getElementById('pres-meta').innerHTML = `
    <span>📅 Inizio: <strong>${new Date(election.votesStartAt).toLocaleDateString('it')}</strong></span>
    <span>⏱ Fine: <strong>${new Date(election.votesEndAt).toLocaleDateString('it')}</strong></span>
    <span>🗳 Voti totali: <strong>${totalVotes.toLocaleString()}</strong></span>
    <a href="${APP_BASE}/country/${election.country}/election/${election._id}" target="_blank" class="pres-meta-link">Vai all'elezione →</a>
  `;

  document.getElementById('badgeCount').textContent = `Presidenziale · ${totalVotes} voti`;
  fillStat('stat-elected', candidates.length);
}

/* ══════════════════════════════════════════════
   CONGRESS ELECTION
══════════════════════════════════════════════ */
async function loadCongressElection(election) {
  showView('congress');

  const elected = election.candidates.filter(c => c.isElected);
  if (!elected.length) throw new Error('Nessun candidato eletto trovato.');

  const partySeatsMap = {}, partyUsersMap = {};
  elected.forEach(c => {
    const pid = String(c.party || c.partyId || 'independent');
    partySeatsMap[pid] = (partySeatsMap[pid] || 0) + 1;
    (partyUsersMap[pid] = partyUsersMap[pid] || []).push(String(c.userId || c.user || ''));
  });
  const electedPartyIds = Object.keys(partySeatsMap);

  setStatus(`Recupero ${electedPartyIds.length} partiti eletti…`, 'loading');

  const electedDetailsMap = {};
  await Promise.all(electedPartyIds.map(async (pid, idx) => {
    try {
      const p = await trpcPost(API2, 'party.getById', { partyId: pid });
      electedDetailsMap[pid] = { ...p, _color: PALETTE[idx % PALETTE.length] };
    } catch (_) {
      electedDetailsMap[pid] = { name:`Partito ${pid.slice(-6)}`, _color: PALETTE[idx % PALETTE.length], members: [] };
    }
  }));

  const allUserIds = new Set();
  elected.forEach(c => { if (c.userId || c.user) allUserIds.add(String(c.userId || c.user)); });
  Object.values(electedDetailsMap).forEach(pd => { if (pd?.leader) allUserIds.add(String(pd.leader)); });
  const userMap = await fetchUsersSequential([...allUserIds]);

  const electedParties = electedPartyIds.map((pid, idx) => {
    const pd       = electedDetailsMap[pid];
    const seats    = partySeatsMap[pid];
    const leaderId = pd.leader ? String(pd.leader) : null;
    const leaderData = leaderId ? (userMap[leaderId] || { username:`#${leaderId.slice(-6)}`, avatarUrl:null }) : null;
    const rawMembers = Array.isArray(pd.members) ? pd.members.length : Number(pd.membersCount || pd.memberCount || 0);
    const users = (partyUsersMap[pid] || []).map(uid => ({
      userId: uid,
      username:  userMap[uid]?.username  || `#${uid.slice(-6)}`,
      avatarUrl: userMap[uid]?.avatarUrl || null,
    }));
    return {
      id: pid,
      name:    pd.name || `Partito ${pid.slice(-6)}`,
      abbr:    pd.abbreviation || pd.abbr || (pd.name || 'P').substring(0, 3).toUpperCase(),
      seats, members: rawMembers,
      leaderName: leaderData?.username || null,
      leaderAvatarUrl: leaderData?.avatarUrl || null,
      leaderId,
      color: pd._color,
      users,
    };
  }).sort((a, b) => b.seats - a.seats);

  const allPartyDetailsMap = { ...electedDetailsMap };
  const missingIds = ALL_PARTY_IDS.filter(pid => !allPartyDetailsMap[pid]);
  if (missingIds.length) {
    setStatus(`Recupero altri ${missingIds.length} partiti…`, 'loading');
    await Promise.all(missingIds.map(async (pid, i) => {
      const colorIdx = electedPartyIds.length + i;
      try {
        const p = await trpcPost(API2, 'party.getById', { partyId: pid });
        allPartyDetailsMap[pid] = { ...p, _color: PALETTE[colorIdx % PALETTE.length] };
      } catch (_) {
        allPartyDetailsMap[pid] = { name:`Partito ${pid.slice(-6)}`, _color: PALETTE[colorIdx % PALETTE.length], members: [] };
      }
    }));
  }
  const allPartyIds = [...new Set([...ALL_PARTY_IDS, ...electedPartyIds])];
  const allParties = allPartyIds.map(pid => {
    const pd = allPartyDetailsMap[pid] || {};
    const rawMembers = Array.isArray(pd.members) ? pd.members.length : Number(pd.membersCount || pd.memberCount || 0);
    return {
      id: pid,
      name:    pd.name || `Partito ${pid.slice(-6)}`,
      abbr:    pd.abbreviation || pd.abbr || (pd.name || 'P').substring(0, 3).toUpperCase(),
      seats:   partySeatsMap[pid] || 0,
      members: rawMembers,
      color:   pd._color || PALETTE[0],
    };
  }).sort((a, b) => b.seats - a.seats || b.members - a.members);
  const totalSeats     = electedParties.reduce((s,p) => s+p.seats, 0);
  const majority       = Math.floor(totalSeats/2)+1;

  fillStat('stat-seats',   totalSeats);
  fillStat('stat-parties', electedParties.length);
  fillStat('stat-elected', elected.length);
  fillStat('stat-majority',majority);
  fillStat('stat-leader',  electedParties[0]?.name||'—');

  await new Promise(resolve => requestAnimationFrame(resolve));

  Parliament.render({
    container:       document.getElementById('parliamentContainer'),
    legendContainer: document.getElementById('legendContainer'),
    parties:         electedParties,
    tooltip:         document.getElementById('tooltip'),
  });

  renderPartyTable(electedParties, totalSeats);
  renderCharts(electedParties);
  renderAllPartiesChart(allParties);

  const badge = `${electedParties.length} partiti · ${totalSeats} seggi`;
  setStatus(badge, '');
  document.getElementById('badgeCount').textContent = badge;
}

/* ══════════════════════════════════════════════
   MAIN ENTRY
══════════════════════════════════════════════ */
async function loadElection(id) {
  const electionId = id || document.getElementById('electionIdInput').value.trim();
  if (!electionId) { setStatus('Inserisci un ID elezione','error'); return; }

  // Cancella una richiesta precedente se ancora in attesa
  if (_pendingRequest) {
    clearTimeout(_pendingRequest.timeout);
    if (_pendingRequest.controller) _pendingRequest.controller.abort();
  }

  // Disabilita temporaneamente i controlli per evitare richieste duplicate
  const selectEl = document.getElementById('electionSelect');
  const inputEl = document.getElementById('electionIdInput');
  const btnEl   = document.getElementById('loadBtn');
  selectEl.disabled = true;
  inputEl.disabled  = true;
  btnEl.disabled    = true;

  // Debounce: aspetta 300ms prima di eseguire la richiesta
  _pendingRequest = {};
  _pendingRequest.timeout = setTimeout(async () => {
    _pendingRequest = null;
    setStatus('Caricamento elezione…','loading');

    try {
      const controller = new AbortController();
      _pendingRequest = { controller };

      const election = await trpcPost(API5, 'election.getElection', { electionId }, controller.signal);
      if (!election?.candidates) throw new Error('Dati elezione mancanti.');

      if (election.type === 'president') {
        await loadPresidentialElection(election);
      } else if (election.type === 'congress') {
        await loadCongressElection(election);
      } else {
        throw new Error(`Tipo sconosciuto: ${election.type}`);
      }

      setStatus('Dati aggiornati','');
    } catch (err) {
      console.error(err);
      if (err.message.includes('429')) {
        setStatus('⚠️ Troppe richieste! Attendi qualche secondo e riprova.','error');
      } else if (err.name !== 'AbortError') {
        setStatus('Errore: '+err.message,'error');
      }
    } finally {
      // Riabilita i controlli
      selectEl.disabled = false;
      inputEl.disabled  = false;
      btnEl.disabled    = false;
    }
  }, 300);
}

/* ── BOOT ── */
document.addEventListener('DOMContentLoaded', () => {
  // Carica lo storico elezioni e automaticamente l'ultima
  loadElectionsHistory();

  // Event listeners
  document.getElementById('loadBtn').addEventListener('click', () => loadElection());
  document.getElementById('electionIdInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') loadElection();
  });

  // Carica automaticamente l'elezione selezionata dal dropdown
  document.getElementById('electionSelect').addEventListener('change', function() {
    if (this.value) {
      document.getElementById('electionIdInput').value = this.value;
      loadElection(this.value);
    }
  });
});