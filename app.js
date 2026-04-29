const API2 = 'https://api2.warera.io/trpc';
const API5 = 'https://api5.warera.io/trpc';
const APP_BASE = 'https://app.warera.io';

const PALETTE = [
  '#3b82f6','#22c55e','#eab308','#ef4444','#a855f7',
  '#f97316','#06b6d4','#ec4899','#84cc16','#f43f5e',
  '#6366f1','#14b8a6','#d946ef','#0ea5e9','#f59e0b',
];

let _partyColorMap = new Map();  // id -> colore dal CSV
let _partyNamesMap = new Map();  // id -> nome (recuperato via API)
let _seatsChart, _membersChart, _allPartiesChart, _presidentChart;
let _apiKey = sessionStorage.getItem('we_key') || '';
let _pendingRequest = null;

/* ── API ── */
async function trpcPost(base, proc, input, signal) {
  const res = await fetch(`${base}/${proc}?batch=1`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', ...(_apiKey && { Authorization:`Bearer ${_apiKey}` }) },
    body: JSON.stringify({ 0: input }),
    signal,
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

/* ── CARICAMENTO CSV PARTITI (id, colore) ── */
async function loadPartyColors(csvUrl) {
  try {
    const res = await fetch(csvUrl);
    if (!res.ok) throw new Error('CSV non trovato');
    const text = await res.text();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      const parts = line.split(',').map(s => s.trim());
      if (parts.length >= 2) {
        const [id, color] = parts;
        if (id && color) _partyColorMap.set(id, color);
      }
    }
    console.log(`🎨 Caricati ${_partyColorMap.size} colori dal CSV`);
  } catch (err) {
    console.warn('Impossibile caricare il CSV dei colori, userò colori di default.', err.message);
  }
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
    
    while (select.options.length > 1) select.remove(1);
    
    items.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    items.forEach(election => {
      const opt = document.createElement('option');
      opt.value = election._id;
      const typeEmoji = election.type === 'president' ? '👤' : '🏛️';
      const date = new Date(election.createdAt).toLocaleDateString('it');
      opt.textContent = `${typeEmoji} ${election.type === 'president' ? 'Presidenziale' : 'Congresso'} · ${date}`;
      select.appendChild(opt);
    });

    if (items.length > 0) {
      const latestElection = items[0];
      select.value = latestElection._id;
      document.getElementById('electionIdInput').value = latestElection._id;
      await loadElection(latestElection._id);
    }
  } catch (err) {
    console.warn('Storico elezioni non disponibile:', err.message);
  }
}

/* ── CONGRESS: party table ── */
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
      <td>${p.votes.toLocaleString()}</td>
      <td><span class="party-pct">${pct}%</span></td>
      <td>${leaderEl}</td>
    </tr>`;
  }).join('');
}

/* ── CONGRESS: half-donut + bar charts ── */
function renderCharts(electedParties) {
  safeDestroy('seatsChart');
  safeDestroy('membersChart');
  if (!electedParties.length) return;

  const colors  = electedParties.map(p => p.color);
  const colorsA = colors.map(c => c+'cc');
  const tt = { backgroundColor:'#0f1521', borderColor:'rgba(197,150,74,.3)', borderWidth:1,
    titleColor:'#e8c97a', bodyColor:'#8892a4', padding:10, cornerRadius:6 };

  _seatsChart = new Chart(document.getElementById('seatsChart').getContext('2d'), {
    type: 'doughnut',
    data: { labels: electedParties.map(p=>p.name), datasets: [{
      data: electedParties.map(p=>p.seats), backgroundColor:colorsA,
      borderColor:'#0e1117', borderWidth:3, hoverBorderColor:colors, hoverBorderWidth:2,
    }]},
    options: { responsive:true, maintainAspectRatio:false, cutout:'65%',
      rotation: -180, circumference: 180,
      plugins: {
        legend: { display: false },
        tooltip: { ...tt, callbacks:{
          title: i => i[0].label,
          label: i => {
            const t = electedParties.reduce((s,p)=>s+p.seats,0);
            const party = electedParties[i.dataIndex];
            return ` ${i.raw} seggi (${((i.raw/t)*100).toFixed(1)}%) · ${party.votes.toLocaleString()} voti`;
          }
        }},
        centerText: {
          id: 'centerText',
          afterDraw(chart) {
            const { ctx, chartArea: { width, height } } = chart;
            const total = chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
            ctx.save();
            ctx.font = 'bold 18px "Playfair Display", serif';
            ctx.fillStyle = '#e8c97a';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${total} seggi`, width / 2, height * 0.75);
            ctx.restore();
          }
        }
      },
      onClick: (_,el) => { if(el.length) window.open(`${APP_BASE}/party/${electedParties[el[0].index].id}`,'_blank'); }
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

/* ── CONGRESS: all-parties chart ── */
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

  // Voti per partito (somma di tutti i candidati, eletti e non)
  const partyVotesMap = {};
  election.candidates.forEach(c => {
    const pid = String(c.party || c.partyId || 'independent');
    const votes = election.votes
      ? (election.votes[String(c.userId || c.user)] || c.voteCount || 0)
      : (c.voteCount || 0);
    partyVotesMap[pid] = (partyVotesMap[pid] || 0) + votes;
  });

  // Mappa temporanea per i dettagli di TUTTI i partiti
  const allPartyDetailsMap = {};

  // Recupera i dettagli dei partiti eletti
  await Promise.all(electedPartyIds.map(async (pid) => {
    if (pid === 'independent') return;
    try {
      const p = await trpcPost(API2, 'party.getById', { partyId: pid });
      allPartyDetailsMap[pid] = p;
      _partyNamesMap.set(pid, p.name);
    } catch (_) {
      allPartyDetailsMap[pid] = { name: `Partito ${pid.slice(-6)}`, members: [] };
    }
  }));

  // Recupera i dettagli dei partiti non eletti presenti nel CSV
  const allCsvIds = [..._partyColorMap.keys()];
  const nonElectedCsvIds = allCsvIds.filter(id => !electedPartyIds.includes(id) && id !== 'independent');
  if (nonElectedCsvIds.length > 0) {
    setStatus(`Recupero ${nonElectedCsvIds.length} partiti dal CSV…`, 'loading');
    await Promise.all(nonElectedCsvIds.map(async (pid) => {
      try {
        const p = await trpcPost(API2, 'party.getById', { partyId: pid });
        allPartyDetailsMap[pid] = p;
        _partyNamesMap.set(pid, p.name);
      } catch (_) {
        allPartyDetailsMap[pid] = { name: `Partito ${pid.slice(-6)}`, members: [] };
      }
    }));
  }

  // Recupera gli utenti (eletti + leader)
  const allUserIds = new Set();
  elected.forEach(c => { if (c.userId || c.user) allUserIds.add(String(c.userId || c.user)); });
  Object.values(allPartyDetailsMap).forEach(pd => { if (pd?.leader) allUserIds.add(String(pd.leader)); });
  const userMap = await fetchUsersSequential([...allUserIds]);

  // Costruisci electedParties
  const electedParties = electedPartyIds.map(pid => {
    const color = _partyColorMap.get(pid) || PALETTE[electedPartyIds.indexOf(pid) % PALETTE.length];
    if (pid === 'independent') {
      return {
        id: pid,
        name: 'Indipendente',
        abbr: 'IND',
        seats: partySeatsMap[pid],
        members: 0,
        votes: partyVotesMap[pid] || 0,
        leaderName: null, leaderAvatarUrl: null, leaderId: null,
        color: '#6b7280',
        users: (partyUsersMap[pid] || []).map(uid => ({
          userId: uid,
          username: userMap[uid]?.username || `#${uid.slice(-6)}`,
          avatarUrl: userMap[uid]?.avatarUrl || null,
        })),
      };
    }

    const pd = allPartyDetailsMap[pid] || {};
    const name = pd.name || _partyNamesMap.get(pid) || `Partito ${pid.slice(-6)}`;
    const leaderId = pd.leader ? String(pd.leader) : null;
    const leaderData = leaderId ? (userMap[leaderId] || { username: `#${leaderId.slice(-6)}`, avatarUrl: null }) : null;
    const rawMembers = Array.isArray(pd.members) ? pd.members.length : Number(pd.membersCount || pd.memberCount || 0);
    const users = (partyUsersMap[pid] || []).map(uid => ({
      userId: uid,
      username: userMap[uid]?.username || `#${uid.slice(-6)}`,
      avatarUrl: userMap[uid]?.avatarUrl || null,
    }));
    return {
      id: pid,
      name,
      abbr: name.substring(0, 3).toUpperCase(),
      seats: partySeatsMap[pid],
      members: rawMembers,
      votes: partyVotesMap[pid] || 0,
      leaderName: leaderData?.username || null,
      leaderAvatarUrl: leaderData?.avatarUrl || null,
      leaderId,
      color,
      users,
    };
  }).sort((a, b) => b.seats - a.seats);

  // Costruisci allParties (tutti i partiti del CSV + eventuali eletti non in CSV)
  const allPartyIds = [...new Set([...allCsvIds, ...electedPartyIds])];
  const allParties = allPartyIds.map(pid => {
    const color = _partyColorMap.get(pid) || '#6b7280';
    const pd = allPartyDetailsMap[pid] || {};
    const name = pd.name || _partyNamesMap.get(pid) || (pid === 'independent' ? 'Indipendente' : `Partito ${pid.slice(-6)}`);
    const rawMembers = Array.isArray(pd.members) ? pd.members.length : Number(pd.membersCount || pd.memberCount || 0);
    return {
      id: pid,
      name,
      abbr: name.substring(0, 3).toUpperCase(),
      seats: partySeatsMap[pid] || 0,
      members: rawMembers,
      votes: partyVotesMap[pid] || 0,
      color,
    };
  }).sort((a, b) => b.seats - a.seats || b.members - a.members);

  const totalSeats = electedParties.reduce((s,p) => s+p.seats, 0);
  const majority   = Math.floor(totalSeats/2)+1;

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
   MAIN ENTRY (con debounce)
══════════════════════════════════════════════ */
async function loadElection(id) {
  const electionId = id || document.getElementById('electionIdInput').value.trim();
  if (!electionId) { setStatus('Inserisci un ID elezione','error'); return; }

  if (_pendingRequest) {
    clearTimeout(_pendingRequest.timeout);
    if (_pendingRequest.controller) _pendingRequest.controller.abort();
  }

  const selectEl = document.getElementById('electionSelect');
  const inputEl  = document.getElementById('electionIdInput');
  const btnEl    = document.getElementById('loadBtn');
  selectEl.disabled = true;
  inputEl.disabled  = true;
  btnEl.disabled    = true;

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
      selectEl.disabled = false;
      inputEl.disabled  = false;
      btnEl.disabled    = false;
    }
  }, 300);
}

/* ── BOOT ── */
document.addEventListener('DOMContentLoaded', () => {
  // Carica i colori dal CSV, poi lo storico elezioni
  loadPartyColors('parties.csv').then(() => {
    loadElectionsHistory();
  });

  document.getElementById('loadBtn').addEventListener('click', () => loadElection());
  document.getElementById('electionIdInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') loadElection();
  });

  document.getElementById('electionSelect').addEventListener('change', function() {
    if (this.value) {
      document.getElementById('electionIdInput').value = this.value;
      loadElection(this.value);
    }
  });
});