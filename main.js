/* ── LOAD ELECTION (entry point) ── */
async function loadElection(id) {
  // Se non viene passato un id, usa quello selezionato nel dropdown
  let electionId = id;
  if (!electionId) {
    const select = document.getElementById('electionSelect');
    electionId = select ? select.value : '';
  }
  if (!electionId) { setStatus('No election selected', 'error'); return; }

  if (_pendingRequest) {
    clearTimeout(_pendingRequest.timeout);
    if (_pendingRequest.controller) _pendingRequest.controller.abort();
  }

  const selectEl = document.getElementById('electionSelect');
  const btnEl = document.getElementById('loadBtn');
  selectEl.disabled = true; btnEl.disabled = true;

  _pendingRequest = {};
  _pendingRequest.timeout = setTimeout(async () => {
    _pendingRequest = null;
    setStatus('Loading election...', 'loading');

    try {
      const controller = new AbortController();
      _pendingRequest = { controller };

      const election = await localFetch('/election', { id: electionId });

      if (_congressCountdownInterval) { clearInterval(_congressCountdownInterval); _congressCountdownInterval = null; }
      if (window._presCountdown) { clearInterval(window._presCountdown); window._presCountdown = null; }

      if (!election || !election.candidates) {
        console.warn('No detail for this ID:', electionId);
        showView('congress');
        hideSkeleton();
        setStatus('⚠️ Election not found or incomplete.', 'error');
        return;
      }

      const isLatestPresidential = (election.type === 'president' && election._id === _latestPresidentialElectionId);
      _currentIsLatestPresidential = isLatestPresidential;

      if (election.type === 'president') await loadPresidentialElection(election, isLatestPresidential);
      else if (election.type === 'congress') await loadCongressElection(election);
      else throw new Error(`Unknown election type: ${election.type}`);

      setStatus('Updated Data', '');

      if (window.umami) {
        window.umami.track('election-load', {
          electionId: election._id,
          type: election.type,
          countryId: election.country || _currentCountryId,
        });
      }
    } catch (err) {
      console.error(err);
      hideSkeleton();
      if (err.message.includes('429')) {
        setStatus('⚠️ Too many requests! Retry after some seconds.', 'error');
      } else if (err.name !== 'AbortError') {
        setStatus('Errore: ' + err.message, 'error');
      }
    } finally {
      selectEl.disabled = false; btnEl.disabled = false;
    }
  }, 300);
}

/* ── BOOT ── */
document.addEventListener('DOMContentLoaded', () => {
  initTheme();

  document.getElementById('partyViewBtn')?.addEventListener('click', showPartyView);
  document.getElementById('themeToggle')?.addEventListener('click', toggleTheme);

  loadPartyColors('parties_6813b6d446e731854c7ac7a2.csv').then(async () => {
    console.log(`🎨 ${_partyColorMap.size} colors loaded from CSV`);
    loadCountries();
    try {
      const data = await localFetch('/countries', {}, { useCache: false });
      _currentCountryData = (data?.items || []).find(c => c._id === _currentCountryId) || null;
    } catch (_) {
      _currentCountryData = null;
    }

    loadElectionsHistory();
    startTicker();
    initPanelSystem();
  });

  /* Re-render charts when a collapsed panel is opened */
  document.querySelectorAll('details.panel').forEach(details => {
    details.addEventListener('toggle', function () {
      if (!this.open) return;
      [
        ['seatsChart', _seatsChart],
        ['membersChart', _membersChart],
        ['allPartiesChart', _allPartiesChart],
        ['timelineChart', _timelineChart],
        ['votesChart', window._votesChart],
      ].forEach(([id, chart]) => {
        if (this.querySelector(`#${id}`) && chart) chart.update();
      });
    });
  });

  /* Country change */
  document.getElementById('countrySelect').addEventListener('change', async function () {
    const newCountryId = this.value;
    localStorage.setItem('preferredCountryId', newCountryId);
    if (newCountryId === _currentCountryId) return;

    _currentCountryId = newCountryId;
    _electionHistory = [];
    _currentCongressElectionId = null;
    _partyColorMap.clear();
    _partyNamesMap.clear();
     document.getElementById('candidatesContainer').style.display = 'none';

    try {
      const data = await localFetch('/countries', {}, { useCache: false });
      _currentCountryData = (data?.items || []).find(c => c._id === newCountryId) || null;
    } catch (_) { _currentCountryData = null; }

    setStatus('Loading…', 'loading');
    try {
      await loadPartiesForCountry(_currentCountryId);
      await loadElectionsHistory();
      // Forza il refresh della timeline dopo cambio paese
      if (typeof _timelineChart !== 'undefined' && _timelineChart) {
        _timelineChart.update();
      }
      
      if (window.umami) window.umami.track('country-change', { country: _currentCountryId });
    } catch (err) {
      console.error('Error switching country:', err);
      setStatus('Error loading data', 'error');
    }

    if (document.getElementById('party-view').style.display !== 'none') {
      loadPartiesForSelector();
      _currentPartyId = null;
      localStorage.removeItem('preferredPartyId');
      document.getElementById('partySelect').tomselect?.setValue('');
      loadPartyDetails(null);
    }
  });

  /* Election controls */
  document.getElementById('loadBtn').addEventListener('click', () => loadElection());
  document.getElementById('electionSelect').addEventListener('change', function () {
    if (this.value) loadElection(this.value);
  });

  /* Toolbar buttons */
  document.getElementById('exportCsvBtn')?.addEventListener('click', () => exportCSV(window._lastElectedParties));
  document.getElementById('fullscreenBtn')?.addEventListener('click', openParliamentFullscreen);
  document.getElementById('overlayClose')?.addEventListener('click', closeParliamentFullscreen);
  document.getElementById('parliamentOverlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('parliamentOverlay')) closeParliamentFullscreen();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeParliamentFullscreen(); });

  /* Simulators */
  document.getElementById('simExpectedVotersInput')?.addEventListener('input', onExpectedVotersChange);
  document.getElementById('simSeatsInput')?.addEventListener('input', onSimSeatsChange);
  document.getElementById('presSimVoters')?.addEventListener('input', onPresSimInput);

  /* Back to elections */
  document.getElementById('backToElectionsBtn')?.addEventListener('click', () => {
    document.getElementById('party-view').style.display = 'none';
    document.getElementById('congress-view').style.display = '';
    if (_currentCongressElectionId) loadElection(_currentCongressElectionId);
  });

  /* Clear cache */
  document.getElementById('clearCacheBtn')?.addEventListener('click', () => {
    cacheClear();
    setStatus('Cache cleared', '');
    setTimeout(() => setStatus('', ''), 2000);
  });
});
