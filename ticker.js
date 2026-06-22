/* ── GLOBAL TICKER – JS RAF loop, seamless, no-flash ── */
let _tickerMessages = [];
let _tickerPos = 0;
let _tickerSpeed = 0.55;
let _tickerRunning = false;
let _tickerUnitWidth = 0;

function toUTCTimestamp(dateStr) {
  if (!dateStr) return null;
  let iso = dateStr;
  if (!iso.endsWith('Z') && !iso.includes('+')) iso += 'Z';
  return new Date(iso).getTime();
}

/* ── ANIMATION LOOP ── */
function _tickerLoop() {
  if (!_tickerRunning) return;
  const track = document.getElementById('tickerTrack');
  if (!track) { requestAnimationFrame(_tickerLoop); return; }

  if (!track.matches(':hover')) {
    _tickerPos += _tickerSpeed;
    if (_tickerUnitWidth > 0 && _tickerPos >= _tickerUnitWidth) {
      _tickerPos -= _tickerUnitWidth;
    }
    track.style.transform = `translateX(${-_tickerPos}px)`;
  }
  requestAnimationFrame(_tickerLoop);
}

/* ── BUILD/UPDATE DOM content without resetting position ── */
function _rebuildTickerContent() {
  const track = document.getElementById('tickerTrack');
  if (!track) return;

  const msgs = _tickerMessages.length ? _tickerMessages : ['📡 Loading global elections...'];
  // triple so we always have content ahead while looping
  const html = [...msgs, ...msgs, ...msgs]
    .map(msg => `<span class="ticker-message">🔹 ${msg}</span><span class="ticker-sep">✦</span>`)
    .join('');
  track.innerHTML = html;

  // measure unit width after paint
  requestAnimationFrame(() => {
    _tickerUnitWidth = track.scrollWidth / 3;
  });
}

/* ── DATA FETCH ── */
async function fetchAllElectionsOnce() {
  try {
    const countriesData = await localFetch('/countries', {}, { useCache: false, ttl: 5 * 60 * 1000 });
    const allCountries = countriesData?.items || [];
    if (!allCountries.length) throw new Error('No countries');

    const now = Date.now();
    const messages = [];

    for (const country of allCountries) {
      try {
        const data = await localFetch('/elections', { countryId: country._id }, { useCache: false, ttl: 5 * 60 * 1000 });
        const elections = data?.items || [];
        const countryName = country.name || country._id;

        for (const e of elections) {
          const start = toUTCTimestamp(e.votesStartAt);
          const end   = toUTCTimestamp(e.votesEndAt);
          if (!start || !end) continue;

          const type      = e.type === 'president' ? 'PRES' : 'CONG';
          const startDate = new Date(start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
          const endDate   = new Date(end).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

          if (now < start) {
            let candidateCount = 0;
            try {
              const detail = await localFetch('/election', { id: e._id }, { useCache: false, ttl: 5 * 60 * 1000 });
              candidateCount = detail.candidates?.length || 0;
            } catch (_) {}
            let msg = `${countryName} ${type} · candidacy open · voting starts ${startDate}`;
            if (candidateCount > 0) msg += ` (${candidateCount} candidates)`;
            messages.push(msg);
          } else if (now >= start && now <= end) {
            let voterCount = 0;
            try {
              const detail = await localFetch('/election', { id: e._id }, { useCache: false, ttl: 2 * 60 * 1000 });
              if (detail.votes && typeof detail.votes === 'object') {
                voterCount = Object.keys(detail.votes).length;
              } else if (detail.votesCount) {
                voterCount = detail.votesCount;
              } else {
                voterCount = detail.candidates?.reduce((s, c) => s + (c.voteCount || 0), 0) || 0;
              }
            } catch (_) {}
            let msg = `${countryName} ${type} · 🔴 live · ends ${endDate}`;
            if (voterCount > 0) msg += ` · ${voterCount.toLocaleString()} votes`;
            messages.push(msg);
          }
        }
      } catch (_) {}
    }

    _tickerMessages = messages.length ? messages.slice(0, 30) : ['✅ No ongoing or upcoming elections worldwide'];
    _rebuildTickerContent();
  } catch (err) {
    console.warn('Ticker error:', err);
    _tickerMessages = ['⚠️ Unable to load worldwide election data'];
    _rebuildTickerContent();
  }
}

/* ── INIT ── */
function startTicker() {
  // The existing HTML is: .news-ticker-wrapper > #newsTicker
  // We replace #newsTicker's content and use it as the track directly.
  const container = document.getElementById('newsTicker');
  if (!container) return;

  // Turn #newsTicker into the moving track
  container.id = 'tickerTrack';
  container.style.cssText = [
    'white-space:nowrap',
    'display:inline-block',
    'will-change:transform',
    'animation:none',
    'transform:translateX(0)',
    'padding-left:0',
  ].join(';');
  container.innerHTML = '<span class="ticker-message">📡 Loading global elections...</span>';

  // Start RAF loop
  _tickerPos    = 0;
  _tickerRunning = true;
  requestAnimationFrame(_tickerLoop);

  // Fetch data (updates content without touching position)
  fetchAllElectionsOnce();
  setInterval(fetchAllElectionsOnce, 5 * 60 * 1000);
}

// legacy compat
function renderTicker() { _rebuildTickerContent(); }

window.startTicker  = startTicker;
window.renderTicker = renderTicker;
