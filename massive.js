const MASSIVE_BASE = 'https://api.massive.com';

export function massiveConfigured() {
  return Boolean(process.env.MASSIVE_API_KEY);
}

async function massiveFetch(path, params = {}) {
  if (!massiveConfigured()) {
    const error = new Error('MASSIVE_API_KEY is not configured on the server.');
    error.status = 503;
    throw error;
  }

  const url = new URL(`${MASSIVE_BASE}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });

  const response = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${process.env.MASSIVE_API_KEY}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.message || body?.error || `Massive API returned ${response.status}`);
    error.status = response.status;
    error.massive = body;
    throw error;
  }
  return body;
}

export function registerMassiveRoutes(app) {
  app.get('/api/massive-status', (_req, res) => {
    res.json({
      configured: massiveConfigured(),
      provider: 'Massive',
      base_url: MASSIVE_BASE,
      message: massiveConfigured() ? 'Massive API key is configured on the backend.' : 'Add MASSIVE_API_KEY to the Render environment.'
    });
  });

  app.get('/api/massive/ticker/:ticker', async (req, res) => {
    try {
      const ticker = String(req.params.ticker || '').trim().toUpperCase();
      if (!/^[A-Z0-9.:-]{1,20}$/.test(ticker)) return res.status(400).json({ error: 'Invalid ticker symbol.' });
      const data = await massiveFetch(`/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(ticker)}`);
      res.json(data);
    } catch (error) {
      console.error('Massive ticker error:', error.massive || error.message);
      res.status(error.status || 500).json({ error: 'Unable to fetch Massive ticker data.', message: error.message });
    }
  });

  app.get('/api/massive/quote/:ticker', async (req, res) => {
    try {
      const ticker = String(req.params.ticker || '').trim().toUpperCase();
      if (!/^[A-Z0-9.:-]{1,20}$/.test(ticker)) return res.status(400).json({ error: 'Invalid ticker symbol.' });
      const data = await massiveFetch(`/v2/last/nbbo/${encodeURIComponent(ticker)}`);
      res.json(data);
    } catch (error) {
      console.error('Massive quote error:', error.massive || error.message);
      res.status(error.status || 500).json({ error: 'Unable to fetch Massive quote data.', message: error.message });
    }
  });

  app.get('/api/massive/news', async (req, res) => {
    try {
      const ticker = req.query.ticker ? String(req.query.ticker).trim().toUpperCase() : undefined;
      const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
      const data = await massiveFetch('/v2/reference/news', { ticker, limit, order: 'desc', sort: 'published_utc' });
      res.json(data);
    } catch (error) {
      console.error('Massive news error:', error.massive || error.message);
      res.status(error.status || 500).json({ error: 'Unable to fetch Massive market news.', message: error.message });
    }
  });

  app.get('/api/massive/market-status', async (_req, res) => {
    try {
      res.json(await massiveFetch('/v1/marketstatus/now'));
    } catch (error) {
      console.error('Massive market status error:', error.massive || error.message);
      res.status(error.status || 500).json({ error: 'Unable to fetch market status.', message: error.message });
    }
  });
}
