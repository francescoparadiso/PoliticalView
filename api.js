/* ── API ── */
async function localFetch(path, params = {}, { useCache = true, ttl = null } = {}) {
  const key = cacheKey(path, params);
  if (useCache) {
    const cached = cacheGet(key);
    if (cached) return cached;
  }
  const cleanPath = path.replace('/api/', '');
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}${cleanPath}${qs ? '?' + qs : ''}`;
  const headers = { ...(_apiKey && { Authorization: `Bearer ${_apiKey}` }) };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} → ${cleanPath}`);
  let json = await res.json();
  if (Array.isArray(json)) json = { items: json };
  if (useCache) {
    const autoTtl = ttl ?? (cleanPath === 'election' ? CACHE_TTL_SHORT : CACHE_TTL_LONG);
    cacheSet(key, json, autoTtl);
  }
  return json;
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
        const color = parts[parts.length - 1];
        if (id && color) _csvColorMap.set(id, color);
      }
    });
    console.log(`🎨 ${_csvColorMap.size} colors loaded from CSV`);
  } catch (err) {
    console.warn('CSV colors not loaded:', err.message);
  }
}
