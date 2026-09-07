const contentStore = new Map();
const userActions = new Map();
const commentsStore = new Map();

function safeId(value) {
  const id = String(value || '').trim();
  return id && id.length <= 200 ? id : null;
}

function getContent(id) {
  if (!contentStore.has(id)) contentStore.set(id, { likes: 0, shares: 0, followers: 0 });
  return contentStore.get(id);
}

function getUser(req) {
  const supplied = String(req.get('x-user-id') || '').trim();
  return supplied && supplied.length <= 100 ? supplied : 'anonymous';
}

function getActions(user, id) {
  const key = `${user}:${id}`;
  if (!userActions.has(key)) userActions.set(key, { liked: false, followed: false });
  return userActions.get(key);
}

function getComments(id) {
  if (!commentsStore.has(id)) commentsStore.set(id, []);
  return commentsStore.get(id);
}

export function registerEngagementRoutes(app) {
  app.get('/api/engagement/:contentId', (req, res) => {
    const id = safeId(req.params.contentId);
    if (!id) return res.status(400).json({ error: 'Invalid content id.' });
    const user = getUser(req);
    res.json({ content_id: id, ...getContent(id), ...getActions(user, id), comments: getComments(id) });
  });

  app.post('/api/engagement/:contentId/:action', (req, res) => {
    const id = safeId(req.params.contentId);
    const action = String(req.params.action || '').toLowerCase();
    if (!id || !['like', 'follow', 'share'].includes(action)) {
      return res.status(400).json({ error: 'Invalid content id or action.' });
    }

    const user = getUser(req);
    const content = getContent(id);
    const actions = getActions(user, id);

    if (action === 'like') {
      actions.liked = !actions.liked;
      content.likes = Math.max(0, content.likes + (actions.liked ? 1 : -1));
    } else if (action === 'follow') {
      actions.followed = !actions.followed;
      content.followers = Math.max(0, content.followers + (actions.followed ? 1 : -1));
    } else {
      content.shares += 1;
    }

    res.json({ content_id: id, ...content, ...actions, comments: getComments(id) });
  });

  app.get('/api/engagement/:contentId/comments', (req, res) => {
    const id = safeId(req.params.contentId);
    if (!id) return res.status(400).json({ error: 'Invalid content id.' });
    res.json({ content_id: id, comments: getComments(id) });
  });

  app.post('/api/engagement/:contentId/comments', (req, res) => {
    const id = safeId(req.params.contentId);
    const text = String(req.body?.text || '').trim();
    if (!id) return res.status(400).json({ error: 'Invalid content id.' });
    if (!text || text.length > 1000) return res.status(400).json({ error: 'Comment must contain 1-1000 characters.' });

    const comments = getComments(id);
    const comment = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      user_id: getUser(req),
      text,
      created_at: new Date().toISOString()
    };
    comments.push(comment);
    if (comments.length > 200) comments.splice(0, comments.length - 200);
    res.status(201).json({ content_id: id, comment, comments });
  });
}
