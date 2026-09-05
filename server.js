import express from 'express';
import cors from 'cors';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 10000;
const X_API_BASE = 'https://api.x.com/2';
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const X_USERNAME = (process.env.X_USERNAME || 'FabrizioRomano').replace(/^@/, '');
const CACHE_MS = Number(process.env.X_CACHE_MS || 120000);
const YOUTUBE_CACHE_MS = Number(process.env.YOUTUBE_CACHE_MS || 120000);

app.use(cors());
app.use(express.json());

let cache = { expiresAt: 0, data: null };
let userCache = { id: null, username: null, expiresAt: 0 };
let youtubeCache = new Map();

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
    access_token_secret: Boolean(config.accessTokenSecret),
    youtube_api_key: Boolean(process.env.YOUTUBE_API_KEY)
  };
}

function requireBearer() {
  if (!process.env.X_BEARER_TOKEN) {
    const error = new Error('X_BEARER_TOKEN is not configured on the server.');
    error.status = 503;
    throw error;
  }
}

function requireYouTubeKey() {
  if (!process.env.YOUTUBE_API_KEY) {
    const error = new Error('YOUTUBE_API_KEY is not configured on the server.');
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

async function youtubeFetch(path, params = {}) {
  requireYouTubeKey();
  const url = new URL(`${YOUTUBE_API_BASE}${path}`);
  Object.entries({ ...params, key: process.env.YOUTUBE_API_KEY }).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });

  const response = await fetch(url, {
    headers: { Accept: 'application/json' }
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = body?.error?.message || `YouTube API returned ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.youtube = body;
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

function normalizeYouTubeVideos(payload) {
  return (payload.items || []).map(item => {
    const videoId = item.id?.videoId || item.id;
    const snippet = item.snippet || {};
    const statistics = item.statistics || {};
    return {
      id: videoId,
      title: snippet.title || '',
      description: snippet.description || '',
      published_at: snippet.publishedAt || null,
      channel_id: snippet.channelId || null,
      channel_title: snippet.channelTitle || '',
      thumbnails: snippet.thumbnails || {},
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
      statistics: item.statistics ? {
        view_count: statistics.viewCount || '0',
        like_count: statistics.likeCount || '0',
        comment_count: statistics.commentCount || '0'
      } : null
    };
  });
}

async function fetchYouTubeVideos(query = 'Fabrizio Romano', limit = 10) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const safeQuery = String(query || 'Fabrizio Romano').trim() || 'Fabrizio Romano';
  const cacheKey = `${safeQuery.toLowerCase()}::${safeLimit}`;
  const cached = youtubeCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.data, cached: true };
  }

  const searchPayload = await youtubeFetch('/search', {
    part: 'snippet',
    q: safeQuery,
    type: 'video',
    order: 'date',
    maxResults: safeLimit
  });

  const videoIds = (searchPayload.items || [])
    .map(item => item.id?.videoId)
    .filter(Boolean);

  let videos = normalizeYouTubeVideos(searchPayload);

  if (videoIds.length) {
    const detailsPayload = await youtubeFetch('/videos', {
      part: 'snippet,statistics',
      id: videoIds.join(',')
    });

    const detailsById = new Map(normalizeYouTubeVideos(detailsPayload).map(video => [video.id, video]));
    videos = videos.map(video => detailsById.get(video.id) || video);
  }

  const data = {
    videos,
    query: safeQuery,
    count: videos.length,
    source: 'YouTube Data API v3',
    fetched_at: new Date().toISOString()
  };

  youtubeCache.set(cacheKey, { data, expiresAt: Date.now() + YOUTUBE_CACHE_MS });
  return { ...data, cached: false };
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

// Diagnostic test for the YouTube API key. Never returns the key itself.
app.get('/api/youtube-test', async (_req, res) => {
  const startedAt = Date.now();
  const configured = Boolean(process.env.YOUTUBE_API_KEY);

  if (!configured) {
    return res.status(503).json({
      ok: false,
      youtube_reachable: false,
      authenticated: false,
      youtube_api_key_configured: false,
      message: 'YOUTUBE_API_KEY is not configured on the server.',
      next_step: 'Add YOUTUBE_API_KEY to the Render environment variables and redeploy.'
    });
  }

  try {
    const payload = await youtubeFetch('/videos', {
      part: 'snippet',
      chart: 'mostPopular',
      regionCode: 'US',
      maxResults: 1
    });

    return res.json({
      ok: true,
      youtube_reachable: true,
      authenticated: true,
      http_status: 200,
      elapsed_ms: Date.now() - startedAt,
      youtube_api_key_configured: true,
      sample_items: Array.isArray(payload.items) ? payload.items.length : 0,
      quota_error: false,
      message: 'YouTube Data API v3 is reachable and the API key is working.'
    });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({
      ok: false,
      youtube_reachable: status !== 502,
      authenticated: false,
      http_status: status,
      elapsed_ms: Date.now() - startedAt,
      youtube_api_key_configured: true,
      youtube_error: {
        message: error.youtube?.error?.message || error.message,
        reason: error.youtube?.error?.errors?.[0]?.reason || null,
        status: error.youtube?.error?.status || null
      },
      message: 'YouTube responded, but the API request was rejected.'
    });
  }
});

app.get('/', (_req, res) => {
  res.json({
    name: 'Fabrizio Romano Backend',
    status: 'ok',
    authentication: {
      supported: ['Bearer Token', 'API Key/Secret', 'OAuth 2.0 Client ID/Secret', 'OAuth 1.0a Access Token/Secret'],
      current_x_read_method: 'Bearer Token',
      youtube_read_method: 'API Key'
    },
    endpoints: ['/health', '/api/x-config', '/api/x-test', '/api/x-posts', '/api/youtube-test', '/api/youtube-videos']
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    x_configured: Boolean(process.env.X_BEARER_TOKEN),
    youtube_configured: Boolean(process.env.YOUTUBE_API_KEY),
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

app.get('/api/youtube-videos', async (req, res) => {
  try {
    const data = await fetchYouTubeVideos(req.query.q, req.query.limit);
    res.json(data);
  } catch (error) {
    console.error('YouTube API error:', error.youtube || error.message);
    res.status(error.status || 500).json({
      error: 'Unable to fetch YouTube videos.',
      message: error.message,
      hint: error.status === 403
        ? 'Check that YouTube Data API v3 is enabled and that the API key has available quota.'
        : undefined
    });
  }
});

app.listen(PORT, () => {
  console.log(`Fabrizio Romano backend listening on port ${PORT}`);
});
