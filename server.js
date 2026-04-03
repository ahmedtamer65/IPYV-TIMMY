const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const http = require('http');
const https = require('https');
const bcrypt = require('bcryptjs');
const { init, getOne, getAll, run } = require('./db');
const restream = require('./restream');

const app = express();
const PORT = process.env.PORT || 3500;
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ===== MULTI-SCREEN / CONNECTION TRACKING =====
// Track active streaming connections per user
const activeConnections = new Map(); // userId -> Set of { ip, userAgent, connectedAt, streamType, streamId }

function trackConnection(userId, req, streamType, streamId) {
  if (!activeConnections.has(userId)) {
    activeConnections.set(userId, new Set());
  }
  const conn = {
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
    connectedAt: new Date().toISOString(),
    streamType,
    streamId
  };
  const userConns = activeConnections.get(userId);
  userConns.add(conn);

  // Remove connection when request closes
  req.on('close', () => {
    userConns.delete(conn);
    if (userConns.size === 0) activeConnections.delete(userId);
  });

  return conn;
}

function checkConnectionLimit(userId, maxConnections) {
  const current = activeConnections.get(userId);
  const count = current ? current.size : 0;
  return count < (maxConnections || 1);
}

function getActiveConnectionCount(userId) {
  const current = activeConnections.get(userId);
  return current ? current.size : 0;
}

// Clean up stale connections every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [userId, conns] of activeConnections.entries()) {
    for (const conn of conns) {
      // Remove connections older than 6 hours (stale)
      if (now - new Date(conn.connectedAt).getTime() > 6 * 60 * 60 * 1000) {
        conns.delete(conn);
      }
    }
    if (conns.size === 0) activeConnections.delete(userId);
  }
}, 60000);

// Admin API to get active connections
app.get('/api/admin/connections', (req, res) => {
  // This should be behind auth but let's keep it simple for now
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Auth required' });

  const jwt = require('jsonwebtoken');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'iptv-learning-secret-key-2024');
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  } catch { return res.status(401).json({ error: 'Invalid token' }); }

  const result = [];
  for (const [userId, conns] of activeConnections.entries()) {
    const user = getOne('SELECT id, username, subscription, max_connections FROM users WHERE id = ?', [userId]);
    if (user) {
      result.push({
        userId: user.id,
        username: user.username,
        subscription: user.subscription,
        maxConnections: user.max_connections,
        activeConnections: conns.size,
        connections: [...conns].map(c => ({
          ip: c.ip,
          userAgent: c.userAgent,
          connectedAt: c.connectedAt,
          streamType: c.streamType,
          streamId: c.streamId
        }))
      });
    }
  }
  res.json({ total: result.reduce((s, r) => s + r.activeConnections, 0), users: result });
});

// ===== ANTI-PIRACY SYSTEM (#12) =====
// Audit logging
function auditLog(userId, username, action, details, req, riskLevel = 'low') {
  try {
    run('INSERT INTO audit_log (user_id, username, action, details, ip_address, user_agent, risk_level) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      userId, username, action, details,
      req ? (req.ip || req.connection?.remoteAddress || 'unknown') : 'system',
      req ? (req.headers?.['user-agent'] || 'unknown') : 'system',
      riskLevel
    ]);
  } catch (e) { /* don't break app for logging failures */ }
}

// Account sharing detection — check if user has many different IPs in short time
function detectAccountSharing(userId, username, req) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';

  // Get unique IPs for this user in last 24 hours
  const recentIPs = getAll(
    'SELECT DISTINCT ip_address FROM audit_log WHERE user_id = ? AND created_at > datetime("now", "-24 hours") AND action = "stream_start"',
    [userId]
  );

  const uniqueIPs = [...new Set([...recentIPs.map(r => r.ip_address), ip])];

  // If more than 3 different IPs in 24 hours, flag as suspicious
  if (uniqueIPs.length > 3) {
    const existing = getOne(
      'SELECT id FROM suspicious_activity WHERE user_id = ? AND type = "account_sharing" AND resolved = 0 AND detected_at > datetime("now", "-24 hours")',
      [userId]
    );
    if (!existing) {
      run('INSERT INTO suspicious_activity (user_id, type, description, ip_addresses) VALUES (?, ?, ?, ?)', [
        userId, 'account_sharing',
        `User "${username}" accessed from ${uniqueIPs.length} different IPs in 24 hours`,
        JSON.stringify(uniqueIPs)
      ]);
      auditLog(userId, username, 'sharing_detected', `${uniqueIPs.length} different IPs: ${uniqueIPs.join(', ')}`, req, 'high');
    }
  }
}

// Watermark endpoint — returns a transparent PNG with username overlay
app.get('/api/watermark', (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).send('Username required');

  // Generate SVG watermark (transparent, positioned randomly)
  const positions = [
    { x: 10, y: 30 }, { x: 70, y: 80 }, { x: 30, y: 50 },
    { x: 50, y: 20 }, { x: 80, y: 60 }
  ];
  const pos = positions[Math.floor(Date.now() / 60000) % positions.length];

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
    <text x="${pos.x}%" y="${pos.y}%" fill="rgba(255,255,255,0.03)" font-size="14" font-family="Arial" transform="rotate(-30, 960, 540)">${username}</text>
    <text x="${(pos.x + 40) % 100}%" y="${(pos.y + 30) % 100}%" fill="rgba(255,255,255,0.03)" font-size="12" font-family="Arial" transform="rotate(-30, 960, 540)">${new Date().toISOString().split('T')[0]} ${username}</text>
  </svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(svg);
});

// Admin: Get audit log
app.get('/api/admin/audit-log', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Auth required' });
  const jwt = require('jsonwebtoken');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'iptv-learning-secret-key-2024');
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  } catch { return res.status(401).json({ error: 'Invalid token' }); }

  const limit = parseInt(req.query.limit) || 100;
  const riskFilter = req.query.risk;
  let sql = 'SELECT * FROM audit_log';
  const params = [];
  if (riskFilter) {
    sql += ' WHERE risk_level = ?';
    params.push(riskFilter);
  }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);

  res.json(getAll(sql, params));
});

// Admin: Get suspicious activities
app.get('/api/admin/suspicious', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Auth required' });
  const jwt = require('jsonwebtoken');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'iptv-learning-secret-key-2024');
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  } catch { return res.status(401).json({ error: 'Invalid token' }); }

  const unresolved = req.query.unresolved === 'true';
  let sql = 'SELECT sa.*, u.username FROM suspicious_activity sa LEFT JOIN users u ON sa.user_id = u.id';
  if (unresolved) sql += ' WHERE sa.resolved = 0';
  sql += ' ORDER BY sa.id DESC LIMIT 100';
  res.json(getAll(sql, []));
});

// Admin: Resolve suspicious activity
app.put('/api/admin/suspicious/:id/resolve', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Auth required' });
  const jwt = require('jsonwebtoken');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'iptv-learning-secret-key-2024');
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  } catch { return res.status(401).json({ error: 'Invalid token' }); }

  run('UPDATE suspicious_activity SET resolved = 1 WHERE id = ?', [req.params.id]);
  res.json({ message: 'Resolved' });
});

// ===== XTREAM CODES STREAM ENDPOINTS (must be BEFORE static middleware) =====
// These intercept /:username/:password/:streamId patterns before Express static catches them

// Live stream: /:username/:password/:channelId
app.get('/:username/:password/:streamId', (req, res, next) => {
  const { username, password, streamId } = req.params;

  // Quick check: streamId should be numeric (with optional extension)
  const cleanId = streamId.replace(/\.(ts|m3u8|mp4|mkv|avi)$/, '');
  if (!/^\d+$/.test(cleanId)) return next();

  // Check if this is a real user
  const user = getOne('SELECT * FROM users WHERE username = ?', [username]);
  if (!user) return next(); // Not a user — pass to static/other routes

  if (!bcrypt.compareSync(password, user.password)) {
    return res.status(401).send('Invalid credentials');
  }
  if (!user.is_active) return res.status(403).send('Account disabled');

  // Check connection limit
  if (!checkConnectionLimit(user.id, user.max_connections)) {
    return res.status(403).send(`Max connections (${user.max_connections}) reached`);
  }

  const channel = getOne('SELECT * FROM channels WHERE id = ?', [cleanId]);
  if (!channel || !channel.stream_url) {
    return res.status(404).send('Channel not found');
  }

  run('UPDATE users SET last_login = datetime("now") WHERE id = ?', [user.id]);
  trackConnection(user.id, req, 'live', cleanId);
  auditLog(user.id, user.username, 'stream_start', `Live channel ${cleanId}: ${channel.name}`, req);
  detectAccountSharing(user.id, user.username, req);

  const streamUrl = channel.stream_url;

  // Local file
  if (streamUrl.startsWith('/media/') || streamUrl.startsWith('/hls/')) {
    const filePath = path.join(BASE_DIR, streamUrl);
    if (fs.existsSync(filePath)) return res.sendFile(filePath);
    return res.status(404).send('File not found');
  }

  // External URL — proxy the stream
  function fetchStream(url, redirectCount) {
    if (redirectCount > 5) {
      if (!res.headersSent) res.status(502).send('Too many redirects');
      return;
    }
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      agent: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Connection': 'keep-alive'
      }
    };

    const proxyReq = client.request(options, (proxyRes) => {
      if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        proxyRes.resume();
        const redirectUrl = proxyRes.headers.location.startsWith('http')
          ? proxyRes.headers.location
          : new URL(proxyRes.headers.location, url).href;
        fetchStream(redirectUrl, redirectCount + 1);
        return;
      }

      proxyRes.socket.setTimeout(0);
      proxyRes.socket.setKeepAlive(true, 5000);

      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'video/mp2t');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.flushHeaders();

      proxyRes.on('data', (chunk) => {
        if (!res.writableEnded) res.write(chunk);
      });
      proxyRes.on('end', () => { if (!res.writableEnded) res.end(); });
      proxyRes.on('error', () => { if (!res.writableEnded) res.end(); });
    });

    proxyReq.on('error', (err) => {
      console.error('Xtream live proxy error:', err.message);
      if (!res.headersSent) res.status(502).send('Stream unavailable');
    });

    proxyReq.on('socket', (socket) => {
      socket.setTimeout(30000);
      socket.once('timeout', () => {
        if (!res.headersSent) { proxyReq.destroy(); res.status(504).send('Timeout'); }
      });
      socket.once('connect', () => { socket.setTimeout(0); socket.setKeepAlive(true, 5000); });
    });

    proxyReq.end();
    req.on('close', () => proxyReq.destroy());
  }

  fetchStream(streamUrl, 0);
});

// VOD (movie) stream: /movie/:username/:password/:movieId.mp4
app.get('/movie/:username/:password/:movieId', (req, res, next) => {
  const { username, password, movieId } = req.params;
  const cleanId = movieId.replace(/\.(mp4|mkv|avi|ts|m3u8)$/, '');
  if (!/^\d+$/.test(cleanId)) return next();

  const user = getOne('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).send('Invalid credentials');
  }
  if (!user.is_active) return res.status(403).send('Account disabled');

  if (!checkConnectionLimit(user.id, user.max_connections)) {
    return res.status(403).send(`Max connections (${user.max_connections}) reached`);
  }

  const movie = getOne('SELECT * FROM movies WHERE id = ?', [cleanId]);
  if (!movie || !movie.video_url) return res.status(404).send('Movie not found');

  run('UPDATE users SET last_login = datetime("now") WHERE id = ?', [user.id]);
  trackConnection(user.id, req, 'vod', cleanId);
  auditLog(user.id, user.username, 'stream_start', `Movie ${cleanId}: ${movie.title}`, req);
  detectAccountSharing(user.id, user.username, req);

  const videoUrl = movie.video_url;
  if (videoUrl.startsWith('/media/') || videoUrl.startsWith('/hls/')) {
    const filePath = path.join(BASE_DIR, videoUrl);
    if (fs.existsSync(filePath)) return res.sendFile(filePath);
    return res.status(404).send('File not found');
  }
  res.redirect(videoUrl);
});

// Series episode stream: /series/:username/:password/:episodeId.mp4
app.get('/series/:username/:password/:episodeId', (req, res, next) => {
  const { username, password, episodeId } = req.params;
  const cleanId = episodeId.replace(/\.(mp4|mkv|avi|ts|m3u8)$/, '');
  if (!/^\d+$/.test(cleanId)) return next();

  const user = getOne('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).send('Invalid credentials');
  }
  if (!user.is_active) return res.status(403).send('Account disabled');

  if (!checkConnectionLimit(user.id, user.max_connections)) {
    return res.status(403).send(`Max connections (${user.max_connections}) reached`);
  }

  const episode = getOne('SELECT * FROM episodes WHERE id = ?', [cleanId]);
  if (!episode || !episode.video_url) return res.status(404).send('Episode not found');

  run('UPDATE users SET last_login = datetime("now") WHERE id = ?', [user.id]);
  trackConnection(user.id, req, 'series', cleanId);
  auditLog(user.id, user.username, 'stream_start', `Episode ${cleanId}: ${episode.title}`, req);
  detectAccountSharing(user.id, user.username, req);

  const videoUrl = episode.video_url;
  if (videoUrl.startsWith('/media/') || videoUrl.startsWith('/hls/')) {
    const filePath = path.join(BASE_DIR, videoUrl);
    if (fs.existsSync(filePath)) return res.sendFile(filePath);
    return res.status(404).send('File not found');
  }
  res.redirect(videoUrl);
});

// Static files
app.use('/admin', express.static(path.join(BASE_DIR, 'public', 'admin')));
app.use('/player', express.static(path.join(BASE_DIR, 'public', 'player')));
app.use('/media', express.static(path.join(BASE_DIR, 'media')));

// Serve HLS segments
app.use('/hls', express.static(path.join(BASE_DIR, 'hls'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache, no-store');
    } else if (filePath.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/content', require('./routes/content'));

// ===== RESTREAM ROUTES =====
app.use('/restream', require('./routes/restream'));

// Direct stream access: /live/:streamId → pipe MPEG-TS
app.get('/live/:streamId', (req, res) => {
  const id = req.params.streamId;
  const stream = restream.getStream(id);
  if (!stream) return res.status(404).send('Stream not found');

  const tsPath = path.join(BASE_DIR, 'streams', `${id}.ts`);
  if (!fs.existsSync(tsPath)) {
    return res.status(404).send('Stream not ready - still buffering');
  }

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const readStream = fs.createReadStream(tsPath);
  readStream.pipe(res);
  readStream.on('error', () => res.end());
  req.on('close', () => readStream.destroy());
});

// ===== STREAM PROXY =====
// Proxies external MPEG-TS streams to bypass CORS (follows redirects)
// Format: /proxy/stream?url=encoded_url
app.get('/proxy/stream', (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl) return res.status(400).send('URL required');

  // Only allow authenticated users (optional)
  const { username, password: pass } = req.query;
  if (username && pass) {
    const user = getOne('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !bcrypt.compareSync(pass, user.password)) {
      return res.status(401).send('Invalid credentials');
    }
  }

  function fetchStream(url, redirectCount) {
    if (redirectCount > 5) {
      if (!res.headersSent) res.status(502).send('Too many redirects');
      return;
    }
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      agent: false, // no connection pooling - dedicated socket
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Connection': 'keep-alive'
      }
    };

    const proxyReq = client.request(options, (proxyRes) => {
      // Follow redirects
      if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        proxyRes.resume();
        const redirectUrl = proxyRes.headers.location.startsWith('http')
          ? proxyRes.headers.location
          : new URL(proxyRes.headers.location, url).href;
        console.log('Proxy redirect:', proxyRes.statusCode, '->', redirectUrl);
        fetchStream(redirectUrl, redirectCount + 1);
        return;
      }

      // Disable socket timeout for live streaming
      proxyRes.socket.setTimeout(0);
      proxyRes.socket.setKeepAlive(true, 5000);

      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'video/mp2t');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.flushHeaders(); // send headers immediately

      proxyRes.on('data', (chunk) => {
        if (!res.writableEnded) {
          res.write(chunk);
        }
      });

      proxyRes.on('end', () => {
        console.log('Proxy: upstream stream ended for', parsedUrl.hostname);
        if (!res.writableEnded) res.end();
      });

      proxyRes.on('error', (err) => {
        console.error('Proxy upstream error:', err.message);
        if (!res.writableEnded) res.end();
      });
    });

    proxyReq.on('error', (err) => {
      console.error('Proxy connection error:', err.message);
      if (!res.headersSent) res.status(502).send('Stream unavailable');
    });

    proxyReq.on('socket', (socket) => {
      socket.setTimeout(30000); // 30s to connect
      socket.once('timeout', () => {
        // Only destroy if we haven't got a response yet
        if (!res.headersSent) {
          proxyReq.destroy();
          res.status(504).send('Connection timeout');
        }
      });
      // Once connected, remove the timeout
      socket.once('connect', () => {
        socket.setTimeout(0);
        socket.setKeepAlive(true, 5000);
      });
    });

    proxyReq.end();

    req.on('close', () => {
      proxyReq.destroy();
    });
  }

  fetchStream(streamUrl, 0);
});

// ===== XTREAM CODES COMPATIBLE API =====
// This makes the player work with host + username + password
app.get('/player_api.php', (req, res) => {
  const { username, password, action } = req.query;

  if (!username || !password) {
    return res.status(401).json({ error: 'Credentials required' });
  }

  const user = getOne('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ user_info: { auth: 0, status: 'Disabled', message: 'Invalid credentials' } });
  }
  if (!user.is_active) {
    return res.status(403).json({ user_info: { auth: 0, status: 'Disabled', message: 'Account disabled' } });
  }

  // Update last login
  run('UPDATE users SET last_login = datetime("now") WHERE id = ?', [user.id]);
  auditLog(user.id, user.username, 'api_login', `Action: ${action || 'auth'}`, req);

  // Auth info (no action = login check)
  if (!action) {
    const plan = getOne('SELECT * FROM subscriptions WHERE LOWER(name) = LOWER(?)', [user.subscription]) || {};
    return res.json({
      user_info: {
        auth: 1,
        status: 'Active',
        username: user.username,
        exp_date: user.expires_at || 'Unlimited',
        is_trial: user.subscription === 'trial' ? 1 : 0,
        active_cons: getActiveConnectionCount(user.id),
        created_at: user.created_at,
        max_connections: user.max_connections || 1,
        allowed_output_formats: ['m3u8', 'ts', 'rtmp'],
        subscription: user.subscription,
        quality: plan.quality || 'SD'
      },
      server_info: {
        url: req.protocol + '://' + req.get('host'),
        port: PORT,
        https_port: PORT,
        server_protocol: 'http',
        rtmp_port: '1935',
        timezone: 'UTC',
        timestamp_now: Math.floor(Date.now() / 1000),
        time_now: new Date().toISOString()
      }
    });
  }

  // Get live channels
  if (action === 'get_live_categories') {
    const cats = getAll('SELECT DISTINCT category FROM channels WHERE is_active = 1');
    return res.json(cats.map((c, i) => ({
      category_id: i + 1,
      category_name: c.category,
      parent_id: 0
    })));
  }

  if (action === 'get_live_streams') {
    const channels = getAll('SELECT * FROM channels WHERE is_active = 1 ORDER BY sort_order');
    const cats = [...new Set(channels.map(c => c.category))];
    const baseUrl = req.protocol + '://' + req.get('host');
    return res.json(channels.map(c => ({
      num: c.id,
      name: c.name,
      stream_type: 'live',
      stream_id: c.id,
      stream_icon: c.logo_url || '',
      epg_channel_id: c.epg_id || '',
      added: c.created_at,
      category_id: cats.indexOf(c.category) + 1,
      category_name: c.category,
      direct_source: `${baseUrl}/${username}/${password}/${c.id}`,
      custom_sid: '',
      tv_archive: 0,
      tv_archive_duration: 0
    })));
  }

  // Get VOD (movies)
  if (action === 'get_vod_categories') {
    const cats = getAll('SELECT DISTINCT category FROM movies WHERE is_active = 1');
    return res.json(cats.map((c, i) => ({
      category_id: i + 100,
      category_name: c.category,
      parent_id: 0
    })));
  }

  if (action === 'get_vod_streams') {
    const movies = getAll('SELECT * FROM movies WHERE is_active = 1');
    const cats = [...new Set(movies.map(m => m.category))];
    const baseUrl = req.protocol + '://' + req.get('host');
    return res.json(movies.map(m => ({
      num: m.id,
      name: m.title,
      stream_type: 'movie',
      stream_id: m.id,
      stream_icon: m.poster_url || '',
      rating: m.rating || 0,
      added: m.created_at,
      category_id: cats.indexOf(m.category) + 100,
      category_name: m.category,
      container_extension: 'mp4',
      direct_source: `${baseUrl}/movie/${username}/${password}/${m.id}.mp4`,
      plot: m.description || '',
      duration_secs: (m.duration || 0) * 60,
      year: m.year || ''
    })));
  }

  // Get Series
  if (action === 'get_series_categories') {
    const cats = getAll('SELECT DISTINCT category FROM series WHERE is_active = 1');
    return res.json(cats.map((c, i) => ({
      category_id: i + 200,
      category_name: c.category,
      parent_id: 0
    })));
  }

  if (action === 'get_series') {
    const series = getAll('SELECT * FROM series WHERE is_active = 1');
    const cats = [...new Set(series.map(s => s.category))];
    return res.json(series.map(s => {
      const epCount = getOne('SELECT COUNT(*) as count FROM episodes WHERE series_id = ?', [s.id]);
      return {
        num: s.id,
        name: s.title,
        series_id: s.id,
        cover: s.poster_url || '',
        plot: s.description || '',
        cast: '',
        genre: s.category,
        releaseDate: s.year ? s.year.toString() : '',
        rating: s.rating || 0,
        category_id: cats.indexOf(s.category) + 200,
        category_name: s.category,
        episode_count: epCount ? epCount.count : 0
      };
    }));
  }

  if (action === 'get_series_info') {
    const seriesId = req.query.series_id;
    const series = getOne('SELECT * FROM series WHERE id = ?', [seriesId]);
    if (!series) return res.status(404).json({ error: 'Series not found' });
    const episodes = getAll('SELECT * FROM episodes WHERE series_id = ? ORDER BY season, episode_number', [seriesId]);
    const baseUrl = req.protocol + '://' + req.get('host');
    const seasonMap = {};
    episodes.forEach(ep => {
      if (!seasonMap[ep.season]) seasonMap[ep.season] = [];
      seasonMap[ep.season].push({
        id: ep.id,
        episode_num: ep.episode_number,
        title: ep.title,
        container_extension: 'mp4',
        info: { duration_secs: (ep.duration || 0) * 60, plot: ep.description || '' },
        direct_source: `${baseUrl}/series/${username}/${password}/${ep.id}.mp4`,
        custom_sid: ''
      });
    });
    return res.json({
      seasons: Object.keys(seasonMap).map(s => ({ season_number: parseInt(s), episode_count: seasonMap[s].length })),
      episodes: seasonMap,
      info: { name: series.title, cover: series.poster_url || '', plot: series.description || '', genre: series.category, rating: series.rating }
    });
  }

  res.json({ error: 'Unknown action' });
});

// ===== M3U PLAYLIST GENERATOR =====
// Standard format: /get.php?username=X&password=Y&type=m3u_plus&output=ts
app.get('/get.php', (req, res) => {
  const { username, password, type, output } = req.query;

  if (!username || !password) return res.status(401).send('Credentials required');
  const user = getOne('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).send('Invalid credentials');
  if (!user.is_active) return res.status(403).send('Account disabled');

  const baseUrl = req.protocol + '://' + req.get('host');
  const channels = getAll('SELECT * FROM channels WHERE is_active = 1 ORDER BY sort_order');
  const movies = getAll('SELECT * FROM movies WHERE is_active = 1');
  const seriesList = getAll('SELECT * FROM series WHERE is_active = 1');

  let m3u = '#EXTM3U\n';
  m3u += `#EXTINF:-1 tvg-name="INFO" tvg-logo="" group-title="Server Info",Server: ${baseUrl}\n`;
  m3u += `${baseUrl}/player\n`;

  // Live channels — use Xtream-compatible URLs so external players proxy through our server
  channels.forEach(ch => {
    if (!ch.stream_url) return;
    const logo = ch.logo_url || '';
    m3u += `#EXTINF:-1 tvg-id="${ch.epg_id||''}" tvg-name="${ch.name}" tvg-logo="${logo}" group-title="${ch.category}",${ch.name}\n`;
    m3u += `${baseUrl}/${username}/${password}/${ch.id}\n`;
  });

  // Movies as VOD — use /movie/:username/:password/:id.mp4
  movies.forEach(mv => {
    if (!mv.video_url) return;
    m3u += `#EXTINF:-1 tvg-name="${mv.title}" tvg-logo="${mv.poster_url||''}" group-title="VOD | ${mv.category}",${mv.title} (${mv.year||''})\n`;
    m3u += `${baseUrl}/movie/${username}/${password}/${mv.id}.mp4\n`;
  });

  // Series episodes — use /series/:username/:password/:id.mp4
  seriesList.forEach(s => {
    const episodes = getAll('SELECT * FROM episodes WHERE series_id = ? AND is_active = 1 ORDER BY season, episode_number', [s.id]);
    episodes.forEach(ep => {
      if (!ep.video_url) return;
      m3u += `#EXTINF:-1 tvg-name="${s.title} S${String(ep.season).padStart(2,'0')}E${String(ep.episode_number).padStart(2,'0')}" tvg-logo="${s.poster_url||''}" group-title="Series | ${s.title}",${s.title} - S${String(ep.season).padStart(2,'0')}E${String(ep.episode_number).padStart(2,'0')} - ${ep.title}\n`;
      m3u += `${baseUrl}/series/${username}/${password}/${ep.id}.mp4\n`;
    });
  });

  // 24/7 Movie Channel
  const movieChannel = getAll('SELECT * FROM movies WHERE is_active = 1 AND video_url IS NOT NULL AND video_url != "" ORDER BY RANDOM()');
  if (movieChannel.length > 0) {
    m3u += `#EXTINF:-1 tvg-name="24/7 Movies" tvg-logo="" group-title="Special Channels",🎬 24/7 Movies Channel\n`;
    m3u += `${baseUrl}/live/movies.m3u8?token=${username}:${password}\n`;
  }

  res.setHeader('Content-Type', 'audio/mpegurl');
  res.setHeader('Content-Disposition', `attachment; filename="${username}_playlist.m3u"`);
  res.send(m3u);
});

// ===== 24/7 MOVIE CHANNEL =====
// Serves a dynamic HLS-like playlist that cycles through movies
app.get('/live/movies.m3u8', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).send('Token required');
  const [username, password] = token.split(':');
  const user = getOne('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password || '', user.password)) return res.status(401).send('Invalid');

  const movies = getAll('SELECT * FROM movies WHERE is_active = 1 AND video_url IS NOT NULL AND video_url != ""');
  if (movies.length === 0) return res.status(404).send('No movies');

  // Cycle through movies based on current time
  const now = Math.floor(Date.now() / 1000);
  const avgDuration = 7200; // 2 hours per movie
  const currentIndex = Math.floor(now / avgDuration) % movies.length;
  const currentMovie = movies[currentIndex];
  const nextMovie = movies[(currentIndex + 1) % movies.length];

  // Return a simple redirect to current movie
  // The player will auto-play this
  res.redirect(currentMovie.video_url);
});

// ===== MOVIE CHANNEL API (for player) =====
app.get('/api/movie-channel', (req, res) => {
  const movies = getAll('SELECT * FROM movies WHERE is_active = 1 AND video_url IS NOT NULL AND video_url != "" ORDER BY id');
  if (movies.length === 0) return res.json({ current: null, playlist: [] });

  const now = Math.floor(Date.now() / 1000);
  const avgDuration = 7200;
  const currentIndex = Math.floor(now / avgDuration) % movies.length;

  res.json({
    current: movies[currentIndex],
    next: movies[(currentIndex + 1) % movies.length],
    playlist: movies.map((m, i) => ({
      id: m.id, title: m.title, video_url: m.video_url,
      duration: m.duration, category: m.category, year: m.year,
      is_playing: i === currentIndex
    }))
  });
});

// Root redirect
app.get('/', (req, res) => res.redirect('/admin'));

// Start
async function start() {
  await init();
  app.listen(PORT, () => {
    console.log('');
    console.log('='.repeat(55));
    console.log('   IPTV Learning System Started!');
    console.log('='.repeat(55));
    console.log(`   Admin Panel:   http://localhost:${PORT}/admin`);
    console.log(`   Player:        http://localhost:${PORT}/player`);
    console.log(`   Xtream API:    http://localhost:${PORT}/player_api.php`);
    console.log(`   M3U Playlist:  http://localhost:${PORT}/get.php?username=X&password=Y&type=m3u_plus`);
    console.log('');
    console.log('   --- Xtream Stream Endpoints ---');
    console.log(`   Live Stream:   http://localhost:${PORT}/username/password/channelId`);
    console.log(`   Movie Stream:  http://localhost:${PORT}/movie/username/password/movieId.mp4`);
    console.log(`   Series Stream: http://localhost:${PORT}/series/username/password/episodeId.mp4`);
    console.log('');
    console.log('   --- Restream System ---');
    console.log(`   Add Stream:    POST http://localhost:${PORT}/restream/add-stream`);
    console.log(`   List Streams:  GET  http://localhost:${PORT}/restream/streams`);
    console.log(`   HLS Output:    http://localhost:${PORT}/hls/{id}/index.m3u8`);
    console.log(`   TS Output:     http://localhost:${PORT}/live/{id}`);
    console.log(`   Restream M3U:  http://localhost:${PORT}/restream/playlist.m3u`);
    console.log(`   Status:        http://localhost:${PORT}/restream/status`);
    console.log('='.repeat(55));
    console.log('   Admin Login:   admin / admin123');
    console.log('='.repeat(55));
    console.log('');

    // Start all enabled restreams
    restream.startAllEnabled();

    // Auto-import scheduler — check every 30 minutes
    setInterval(async () => {
      try {
        const sources = getAll('SELECT * FROM import_sources WHERE is_active = 1 AND auto_update = 1');
        for (const src of sources) {
          const hoursSinceImport = src.last_import
            ? (Date.now() - new Date(src.last_import).getTime()) / (1000 * 60 * 60)
            : 999;
          if (hoursSinceImport >= (src.update_interval || 24)) {
            console.log(`Auto-import: Fetching "${src.name}" from ${src.url}`);
            try {
              const content = await new Promise((resolve, reject) => {
                const url = new URL(src.url);
                const client = url.protocol === 'https:' ? https : http;
                client.get(src.url, { timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
                  if ([301, 302, 307].includes(response.statusCode) && response.headers.location) {
                    client.get(response.headers.location, { timeout: 30000 }, (r2) => {
                      let data = ''; r2.on('data', c => data += c); r2.on('end', () => resolve(data));
                    }).on('error', reject);
                    return;
                  }
                  let data = ''; response.on('data', c => data += c); response.on('end', () => resolve(data));
                }).on('error', reject);
              });

              const lines = content.split('\n').map(l => l.trim()).filter(l => l);
              let added = 0, updated = 0;
              const maxSort = (getOne('SELECT MAX(sort_order) as m FROM channels', []) || {}).m || 0;
              let idx = 0;
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXTINF:')) {
                  const info = lines[i];
                  const chUrl = (lines[i + 1] && !lines[i + 1].startsWith('#')) ? lines[i + 1] : '';
                  if (!chUrl) continue;
                  const nameMatch = info.match(/,(.+)$/);
                  const name = nameMatch ? nameMatch[1].trim() : 'Unknown';
                  const groupMatch = info.match(/group-title="([^"]*)"/);
                  const category = groupMatch ? groupMatch[1] : 'imported';
                  const logoMatch = info.match(/tvg-logo="([^"]*)"/);
                  const logo = logoMatch ? logoMatch[1] : '';

                  const existing = getOne('SELECT * FROM channels WHERE name = ?', [name]);
                  if (existing) {
                    run('UPDATE channels SET stream_url=?, logo_url=? WHERE id=?', [chUrl, logo || existing.logo_url || '', existing.id]);
                    updated++;
                  } else {
                    run('INSERT INTO channels (name, category, stream_url, logo_url, sort_order) VALUES (?, ?, ?, ?, ?)', [name, category, chUrl, logo, maxSort + idx + 1]);
                    added++;
                  }
                  idx++;
                  i++;
                }
              }
              run('UPDATE import_sources SET last_import=datetime("now"), channels_count=? WHERE id=?', [idx, src.id]);
              console.log(`Auto-import "${src.name}": ${added} added, ${updated} updated`);
            } catch (e) {
              console.error(`Auto-import "${src.name}" failed:`, e.message);
            }
          }
        }
      } catch (e) { /* ignore scheduler errors */ }
    }, 30 * 60 * 1000); // Check every 30 minutes
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
