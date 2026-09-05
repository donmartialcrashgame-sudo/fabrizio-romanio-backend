const WATCHMODE_BASE = 'https://api.watchmode.com/v1';
const WATCHMODE_CACHE_MS = Number(process.env.WATCHMODE_CACHE_MS || 15 * 60 * 1000);
const watchmodeCache = new Map();

function requireWatchmodeKey() {
  if (!process.env.WATCHMODE_API_KEY) {
    const error = new Error('WATCHMODE_API_KEY is not configured on the server.');
    error.status = 503;
    throw error;
  }
}

async function watchmodeFetch(path, params = {}) {
  requireWatchmodeKey();
  const url = new URL(`${WATCHMODE_BASE}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-API-Key': process.env.WATCHMODE_API_KEY
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.message || body?.error || `Watchmode API returned ${response.status}`);
    error.status = response.status;
    error.watchmode = body;
    throw error;
  }
  return body;
}

async function cachedWatchmode(key, loader) {
  const cached = watchmodeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.data, cached: true };
  const data = await loader();
  watchmodeCache.set(key, { data, expiresAt: Date.now() + WATCHMODE_CACHE_MS });
  return { ...data, cached: false };
}

function safeLimit(value, fallback = 20) {
  return Math.min(Math.max(Number(value) || fallback, 1), 50);
}

export function watchmodeConfigured() {
  return Boolean(process.env.WATCHMODE_API_KEY);
}

export async function watchmodeStatus() {
  return watchmodeFetch('/status/');
}

export async function watchmodeSearch(query, type = '') {
  const searchValue = String(query || '').trim();
  if (!searchValue) return { title_results: [], people_results: [] };
  const cacheKey = `search:${searchValue.toLowerCase()}:${type}`;
  return cachedWatchmode(cacheKey, async () => watchmodeFetch('/search/', {
    search_field: 'name',
    search_value: searchValue,
    types: type || undefined
  }));
}

export async function watchmodeListTitles({ type = 'movie', region = '', sort = 'popularity_desc', page = 1, limit = 20 } = {}) {
  const safePage = Math.max(Number(page) || 1, 1);
  const safeCount = safeLimit(limit);
  const key = `titles:${type}:${region}:${sort}:${safePage}:${safeCount}`;
  return cachedWatchmode(key, async () => watchmodeFetch('/list-titles/', {
    types: type,
    regions: region || undefined,
    sort_by: sort,
    page: safePage,
    limit: safeCount
  }));
}

export async function watchmodeDetails(id, append = '') {
  const titleId = String(id || '').trim();
  if (!titleId) {
    const error = new Error('A Watchmode title ID is required.');
    error.status = 400;
    throw error;
  }
  const key = `details:${titleId}:${append}`;
  return cachedWatchmode(key, async () => watchmodeFetch(`/title/${encodeURIComponent(titleId)}/details/`, {
    append_to_response: append || undefined
  }));
}

export async function watchmodeSources(id, region = '') {
  const titleId = String(id || '').trim();
  if (!titleId) {
    const error = new Error('A Watchmode title ID is required.');
    error.status = 400;
    throw error;
  }
  const key = `sources:${titleId}:${region}`;
  return cachedWatchmode(key, async () => watchmodeFetch(`/title/${encodeURIComponent(titleId)}/sources/`, {
    regions: region || undefined
  }));
}

export async function watchmodeGenres() {
  return cachedWatchmode('genres', async () => ({ genres: await watchmodeFetch('/genres/') }));
}

export async function watchmodeProviders(region = '') {
  const key = `sources:${region}`;
  return cachedWatchmode(key, async () => ({ sources: await watchmodeFetch('/sources/', {
    regions: region || undefined
  }) }));
}

export function registerWatchmodeRoutes(app) {
  app.get('/api/watchmode-test', async (_req, res) => {
    const startedAt = Date.now();
    if (!watchmodeConfigured()) {
      return res.status(503).json({
        ok: false,
        watchmode_reachable: false,
        authenticated: false,
        watchmode_api_key_configured: false,
        message: 'WATCHMODE_API_KEY is not configured on the server.',
        next_step: 'Add WATCHMODE_API_KEY to the Render environment variables and redeploy.'
      });
    }
    try {
      const status = await watchmodeStatus();
      return res.json({
        ok: true,
        watchmode_reachable: true,
        authenticated: true,
        elapsed_ms: Date.now() - startedAt,
        watchmode_api_key_configured: true,
        quota: status?.quota ?? null,
        quota_used: status?.quotaUsed ?? null,
        message: 'Watchmode API is reachable and the API key is working.'
      });
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        watchmode_reachable: error.status !== 502,
        authenticated: false,
        elapsed_ms: Date.now() - startedAt,
        watchmode_api_key_configured: true,
        watchmode_error: error.watchmode || { message: error.message },
        message: 'Watchmode responded, but the API request was rejected.'
      });
    }
  });

  app.get('/api/movies', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const type = String(req.query.type || 'movie');
      const region = String(req.query.region || process.env.WATCHMODE_REGION || 'US').toUpperCase();
      const sort = String(req.query.sort || 'popularity_desc');
      const limit = safeLimit(req.query.limit, 24);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const data = q
        ? await watchmodeSearch(q, type === 'movie' ? 'movie' : '')
        : await watchmodeListTitles({ type, region, sort, page, limit });
      res.json({ ...data, query: q, region, type, source: 'Watchmode' });
    } catch (error) {
      console.error('Watchmode movies error:', error.watchmode || error.message);
      res.status(error.status || 500).json({ error: 'Unable to fetch movie data.', message: error.message });
    }
  });

  app.get('/api/movies/:id', async (req, res) => {
    try {
      const append = String(req.query.append || '');
      const data = await watchmodeDetails(req.params.id, append);
      res.json({ ...data, source: 'Watchmode' });
    } catch (error) {
      console.error('Watchmode title error:', error.watchmode || error.message);
      res.status(error.status || 500).json({ error: 'Unable to fetch title details.', message: error.message });
    }
  });

  app.get('/api/movies/:id/sources', async (req, res) => {
    try {
      const region = String(req.query.region || process.env.WATCHMODE_REGION || 'US').toUpperCase();
      const sources = await watchmodeSources(req.params.id, region);
      res.json({ sources, region, source: 'Watchmode' });
    } catch (error) {
      console.error('Watchmode sources error:', error.watchmode || error.message);
      res.status(error.status || 500).json({ error: 'Unable to fetch streaming availability.', message: error.message });
    }
  });

  app.get('/api/movie-genres', async (_req, res) => {
    try {
      res.json({ ...(await watchmodeGenres()), source: 'Watchmode' });
    } catch (error) {
      res.status(error.status || 500).json({ error: 'Unable to fetch movie genres.', message: error.message });
    }
  });

  app.get('/api/movie-providers', async (req, res) => {
    try {
      const region = String(req.query.region || process.env.WATCHMODE_REGION || 'US').toUpperCase();
      res.json({ ...(await watchmodeProviders(region)), region, source: 'Watchmode' });
    } catch (error) {
      res.status(error.status || 500).json({ error: 'Unable to fetch streaming providers.', message: error.message });
    }
  });
}
