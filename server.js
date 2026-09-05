import express from 'express';
import cors from 'cors';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 10000;
const X_API_BASE = 'https://api.x.com/2';
const X_USERNAME = (process.env.X_USERNAME || 'FabrizioRomano').replace(/^@/, '');
const CACHE_MS = Number(process.env.X_CACHE_MS || 120000);

app.use(cors());
app.use(express.json());

let cache = { expiresAt: 0, data: null };
let userCache = { id: null, username: null, expiresAt: 0 };

function getXConfig() {
  return {
    bearerToken: process.env.X_BEARER_TOKEN || '',
    apiKey: process.env.X_API_KEY || '',
    apiSecret: process.env.X_API_SECRET || '',
    clientId: process.env.X_CLIENT_ID || '',
    clientSecret: process.env.X_CLIENT_SECRET || '',
    accessToken: process.env.X_ACCESS_TOKEN || '',
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET || ''
  };
}

function getCredentialStatus() {
  const config = getXConfig();
  return {
    bearer_token: Boolean(config.bearerToken),
    api_key: Boolean(config.apiKey),
    api_secret: Boolean(config.apiSecret),
    client_id: Boolean(config.clientId),
    client_secret: Boolean(config.clientSecret),
    access_token: Boolean(config.accessToken),
    access_token_secret: Boolean(config.accessTokenSecret)
  };
}

function requireBearer() {
  if (!process.env.X_BEARER_TOKEN) {
    const error = new Error('X_BEARER_TOKEN is not configured on the server.');
    error.status = 503;
    throw error;
  }
}

async function xFetch(path, options = {}) {
  requireBearer();
  const response = await fetch(`${X_API_BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
      Accept: 'application/json',
      ...(options.headers || {})
    },
    body: options.body
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.detail || body?.title || body?.errors?.[0]?.message || `X API returned ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.x = body;
    throw error;
  }
  return body;
}

async function getUser() {
  if (userCache.id && userCache.expiresAt > Date.now()) return userCache;

  const data = await xFetch(`/users/by/username/${encodeURIComponent(X_USERNAME)}?user.fields=id,name,username,profile_image_url,description,verified`);
  if (!data?.data?.id) throw new Error(`X user @${X_USERNAME} was not found.`);

  userCache = {
    id: data.data.id,
    username: data.data.username,
    name: data.data.name,
    profile_image_url: data.data.profile_image_url || null,
    description: data.data.description || '',
    verified: Boolean(data.data.verified),
    expiresAt: Date.now() + 15 * 60 * 1000
  };
  return userCache;
}

function normalizePosts(payload, user) {
  const mediaByKey = new Map((payload.includes?.media || []).map(media => [media.media_key, media]));

  return (payload.data || []).map(post => {
    const media = (post.attachments?.media_keys || [])
      .map(key => mediaByKey.get(key))
      .filter(Boolean)
      .map(item => ({
        type: item.type,
        url: item.url || item.preview_image_url || null,
        preview_image_url: item.preview_image_url || null,
        width: item.width || null,
        height: item.height || null
      }));

    return {
      id: post.id,
      text: post.text || '',
      created_at: post.created_at || null,
      url: `https://x.com/${user.username}/status/${post.id}`,
      author: {
        id: user.id,
        name: user.name,
        username: user.username,
        profile_image_url: user.profile_image_url,
        verified: user.verified
      },
      public_metrics: post.public_metrics || null,
      media
    };
  });
}

async function fetchRecentPosts(limit = 10) {
  const user = await getUser();
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 5), 100);
  const params = new URLSearchParams({
    max_results: String(safeLimit),
    'tweet.fields': 'id,text,created_at,attachments,public_metrics,lang,conversation_id',
    expansions: 'attachments.media_keys,author_id',
    'media.fields': 'media_key,type,url,preview_image_url,width,height,duration_ms,alt_text',
    exclude: 'replies,retweets'
  });

  const payload = await xFetch(`/users/${user.id}/tweets?${params.toString()}`);
  return {
    posts: normalizePosts(payload, user),
    meta: payload.meta || {},
    source: 'X API v2',
    fetched_at: new Date().toISOString()
  };
}

// Diagnostic test: makes one small authenticated request to X and reports
// the result without ever returning any credential values.
app.get('/api/x-test', async (_req, res) => {
  const credentials = getCredentialStatus();
  const startedAt = Date.now();

  if (!credentials.bearer_token) {
    return res.status(503).json({
      ok: false,
      x_reachable: false,
      authentication: 'bearer_token',
      credentials,
      message: 'X_BEARER_TOKEN is not configured on the server.',
      next_step: 'Add the X Bearer Token to the Render environment variables.'
    });
  }

  try {
    const response = await fetch(`${X_API_BASE}/users/by/username/${encodeURIComponent(X_USERNAME)}?user.fields=id,name,username`, {
      headers: {
        Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
        Accept: 'application/json'
      }
    });

    const body = await response.json().catch(() => ({}));
    const elapsed_ms = Date.now() - startedAt;

    if (response.ok) {
      return res.json({
        ok: true,
        x_reachable: true,
        authenticated: true,
        http_status: response.status,
        elapsed_ms,
        username_requested: X_USERNAME,
        x_user: body?.data ? {
          id: body.data.id,
          name: body.data.name,
          username: body.data.username
        } : null,
        credentials,
        message: 'X API authentication and user lookup are working.'
      });
    }

    return res.status(response.status).json({
      ok: false,
      x_reachable: true,
      authenticated: false,
      http_status: response.status,
      elapsed_ms,
      username_requested: X_USERNAME,
      credentials,
      x_error: {
        title: body?.title || null,
        detail: body?.detail || null,
        type: body?.type || null,
        errors: Array.isArray(body?.errors)
          ? body.errors.map(item => ({ title: item?.title || null, detail: item?.detail || null, type: item?.type || null }))
          : undefined
      },
      message: 'X responded, but the current Bearer Token request was rejected.'
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      x_reachable: false,
      authenticated: false,
      elapsed_ms: Date.now() - startedAt,
      credentials,
      message: 'The backend could not reach X.',
      error: error.message
    });
  }
});

app.get('/', (_req, res) => {
  res.json({
    name: 'Fabrizio Romano Backend',
    status: 'ok',
    authentication: {
      supported: ['Bearer Token', 'API Key/Secret', 'OAuth 2.0 Client ID/Secret', 'OAuth 1.0a Access Token/Secret'],
      current_read_method: 'Bearer Token'
    },
    endpoints: ['/health', '/api/x-config', '/api/x-test', '/api/x-posts']
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    x_configured: Boolean(process.env.X_BEARER_TOKEN),
    x_username: X_USERNAME,
    authentication: getCredentialStatus(),
    timestamp: new Date().toISOString()
  });
});

// Safe diagnostics: reports only whether credentials exist, never their values.
app.get('/api/x-config', (_req, res) => {
  res.json({
    username: X_USERNAME,
    credentials: getCredentialStatus(),
    current_read_auth: 'bearer_token'
  });
});

app.get('/api/x-posts', async (req, res) => {
  try {
    if (cache.data && cache.expiresAt > Date.now() && !req.query.refresh) {
      return res.json({ ...cache.data, cached: true });
    }

    const data = await fetchRecentPosts(req.query.limit);
    cache = { data, expiresAt: Date.now() + CACHE_MS };
    res.json({ ...data, cached: false });
  } catch (error) {
    console.error('X API error:', error.x || error.message);
    res.status(error.status || 500).json({
      error: 'Unable to fetch recent X posts.',
      message: error.message,
      hint: error.status === 401 ? 'Check X_BEARER_TOKEN in Render.' : undefined
    });
  }
});

app.listen(PORT, () => {
  console.log(`Fabrizio Romano backend listening on port ${PORT}`);
});
