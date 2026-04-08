const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const http = require('http');
const https = require('https');
const bcrypt = require('bcryptjs');
const { init, getOne, getAll, run } = require('./db');
const restream = require('./restream');

// Load .env file
const BASE_DIR_ENV = process.pkg ? path.dirname(process.execPath) : __dirname;
const envPath = path.join(BASE_DIR_ENV, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...vals] = line.trim().split('=');
    if (key && !key.startsWith('#') && vals.length) {
      process.env[key] = vals.join('=');
    }
  });
  console.log('.env loaded | TMDB_API_KEY:', process.env.TMDB_API_KEY ? 'SET (' + process.env.TMDB_API_KEY.substring(0,8) + '...)' : 'NOT SET');
} else {
  console.log('.env file not found at:', envPath);
}

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

// ===== WATERMARK PROXY (FFmpeg overlay) =====
// Pipes stream through FFmpeg to burn watermark into video for ALL players
function proxyWithWatermark(url, req, res, watermarkOpts) {
  const { spawn } = require('child_process');
  const wm = watermarkOpts || {};
  const wmUrl = wm.url || '';
  const opacity = wm.opacity || 0.8;
  const size = wm.size || 120;
  const position = wm.position || 'top-right';

  // Calculate overlay position
  let overlayPos = 'W-w-10:10'; // top-right default
  if (position === 'top-left') overlayPos = '10:10';
  else if (position === 'top-right') overlayPos = 'W-w-10:10';
  else if (position === 'bottom-left') overlayPos = '10:H-h-10';
  else if (position === 'bottom-right') overlayPos = 'W-w-10:H-h-10';
  else if (position === 'center') overlayPos = '(W-w)/2:(H-h)/2';

  // FFmpeg command: input stream + watermark image overlay
  const ffArgs = [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', url,
    '-i', wmUrl,
    '-filter_complex', `[1:v]scale=${size}:-1,format=rgba,colorchannelmixer=aa=${opacity}[wm];[0:v][wm]overlay=${overlayPos}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-b:v', '2M', '-maxrate', '2.5M', '-bufsize', '5M',
    '-threads', '2',
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'mpegts',
    '-'
  ];

  try {
    const ffmpeg = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');

    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on('data', () => {}); // suppress logs

    ffmpeg.on('error', (err) => {
      console.log('FFmpeg not available, falling back to regular proxy');
      proxyUrl(url, req, res, 'video/mp2t');
    });

    ffmpeg.on('close', () => { if (!res.writableEnded) res.end(); });
    req.on('close', () => { ffmpeg.kill('SIGKILL'); });
  } catch(e) {
    // FFmpeg not installed — fallback to regular proxy
    proxyUrl(url, req, res, 'video/mp2t');
  }
}

// ===== UNIVERSAL PROXY FUNCTION =====
// Proxies any external URL through our server (follows redirects, no timeout for streams)
function proxyUrl(url, req, res, defaultContentType) {
  function doProxy(targetUrl, redirectCount) {
    if (redirectCount > 5) {
      if (!res.headersSent) res.status(502).send('Too many redirects');
      return;
    }
    const parsedUrl = new URL(targetUrl);
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
    // Pass Range header for seeking in VOD
    if (req.headers.range) options.headers['Range'] = req.headers.range;

    const proxyReq = client.request(options, (proxyRes) => {
      if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        proxyRes.resume();
        const rUrl = proxyRes.headers.location.startsWith('http')
          ? proxyRes.headers.location
          : new URL(proxyRes.headers.location, targetUrl).href;
        doProxy(rUrl, redirectCount + 1);
        return;
      }
      proxyRes.socket.setTimeout(0);
      proxyRes.socket.setKeepAlive(true, 5000);

      // Set response headers
      const ct = proxyRes.headers['content-type'] || defaultContentType || 'application/octet-stream';
      // Normalize content-type for video (some servers send 'video/quicktime' for .mov)
      const normalizedCt = ct.includes('quicktime') ? 'video/mp4' : ct;
      res.setHeader('Content-Type', normalizedCt);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache');
      // Always advertise Accept-Ranges for VOD — IPTV Smarters needs this for seeking
      res.setHeader('Accept-Ranges', proxyRes.headers['accept-ranges'] || 'bytes');
      if (proxyRes.headers['content-length']) res.setHeader('Content-Length', proxyRes.headers['content-length']);
      if (proxyRes.headers['content-range']) res.setHeader('Content-Range', proxyRes.headers['content-range']);
      if (proxyRes.statusCode === 206) res.status(206);
      res.flushHeaders();

      proxyRes.on('data', (chunk) => { if (!res.writableEnded) res.write(chunk); });
      proxyRes.on('end', () => { if (!res.writableEnded) res.end(); });
      proxyRes.on('error', () => { if (!res.writableEnded) res.end(); });
    });

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err.message);
      if (!res.headersSent) res.status(502).send('Stream unavailable');
    });
    proxyReq.on('socket', (socket) => {
      socket.setTimeout(30000);
      socket.once('timeout', () => { if (!res.headersSent) { proxyReq.destroy(); res.status(504).send('Timeout'); } });
      socket.once('connect', () => { socket.setTimeout(0); socket.setKeepAlive(true, 5000); });
    });
    proxyReq.end();
    req.on('close', () => proxyReq.destroy());
  }
  doProxy(url, 0);
}

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

  let streamUrl = channel.stream_url;

  // Check watermark settings (FFmpeg burn-in only if wm_ffmpeg enabled)
  const ffmpegEnabled = getOne("SELECT value FROM site_settings WHERE key='wm_ffmpeg'");
  if (ffmpegEnabled && ffmpegEnabled.value === '1') {
    const wmUrl = channel.watermark_url || '';
    const globalWm = getOne("SELECT value FROM site_settings WHERE key='watermark_url'");
    const globalWmOn = getOne("SELECT value FROM site_settings WHERE key='wm_on_channels'");
    const useWm = channel.watermark !== 0 && (globalWmOn ? globalWmOn.value !== '0' : true) && (wmUrl || (globalWm && globalWm.value));
    if (useWm) {
      const finalWmUrl = wmUrl || (globalWm ? globalWm.value : '');
      if (finalWmUrl) {
        const globalPos = getOne("SELECT value FROM site_settings WHERE key='watermark_position'");
        const globalOpacity = getOne("SELECT value FROM site_settings WHERE key='watermark_opacity'");
        const globalSize = getOne("SELECT value FROM site_settings WHERE key='watermark_size'");
        return proxyWithWatermark(streamUrl, req, res, {
          url: finalWmUrl,
          position: channel.watermark_position || (globalPos ? globalPos.value : 'top-right'),
          opacity: channel.watermark_opacity || (globalOpacity ? parseFloat(globalOpacity.value) : 0.8),
          size: channel.watermark_size || (globalSize ? parseInt(globalSize.value) : 120)
        });
      }
    }
  }

  // Local file
  if (streamUrl.startsWith('/media/') || streamUrl.startsWith('/hls/')) {
    const filePath = path.join(BASE_DIR, streamUrl);
    if (fs.existsSync(filePath)) return res.sendFile(filePath);
    return res.status(404).send('File not found');
  }

  // HLS streams (.m3u8) — proxy the manifest and segments properly
  if (streamUrl.includes('.m3u8')) {
    return proxyUrl(streamUrl, req, res, 'application/vnd.apple.mpegurl');
  }

  // ALL external URLs — proxy through our server (no redirects!)
  // IPTV Smarters and most external players do NOT follow redirects
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
  const cleanId = movieId.replace(/\.(mp4|mkv|avi|ts|m3u8|mov)$/, '');
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

  // Watermark check for movies (FFmpeg only if enabled)
  const mFfmpeg = getOne("SELECT value FROM site_settings WHERE key='wm_ffmpeg'");
  if (mFfmpeg && mFfmpeg.value === '1') {
    const mWmUrl = movie.watermark_url || '';
    const mGlobalWm = getOne("SELECT value FROM site_settings WHERE key='watermark_url'");
    const mGlobalWmOn = getOne("SELECT value FROM site_settings WHERE key='wm_on_movies'");
    const mUseWm = movie.watermark !== 0 && (mGlobalWmOn ? mGlobalWmOn.value !== '0' : true) && (mWmUrl || (mGlobalWm && mGlobalWm.value));
    if (mUseWm) {
      const finalWm = mWmUrl || (mGlobalWm ? mGlobalWm.value : '');
      if (finalWm) {
        const gp = getOne("SELECT value FROM site_settings WHERE key='watermark_position'");
        const go = getOne("SELECT value FROM site_settings WHERE key='watermark_opacity'");
        const gs = getOne("SELECT value FROM site_settings WHERE key='watermark_size'");
        return proxyWithWatermark(videoUrl, req, res, {
          url: finalWm, position: movie.watermark_position || (gp?gp.value:'top-right'),
          opacity: movie.watermark_opacity || (go?parseFloat(go.value):0.8), size: movie.watermark_size || (gs?parseInt(gs.value):120)
        });
      }
    }
  }

  if (videoUrl.startsWith('/media/') || videoUrl.startsWith('/hls/')) {
    const filePath = path.join(BASE_DIR, videoUrl);
    if (fs.existsSync(filePath)) return res.sendFile(filePath);
    return res.status(404).send('File not found');
  }
  proxyUrl(videoUrl, req, res, 'video/mp4');
});

// Series episode stream: /series/:username/:password/:episodeId.mp4
app.get('/series/:username/:password/:episodeId', (req, res, next) => {
  const { username, password, episodeId } = req.params;
  const cleanId = episodeId.replace(/\.(mp4|mkv|avi|ts|m3u8|mov)$/, '');
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

  // Watermark check for series (FFmpeg only if enabled)
  const sFfmpeg = getOne("SELECT value FROM site_settings WHERE key='wm_ffmpeg'");
  if (sFfmpeg && sFfmpeg.value === '1') {
    const ser = getOne('SELECT * FROM series WHERE id = ?', [episode.series_id]);
    const sWmUrl = ser?.watermark_url || '';
    const sGlobalWm = getOne("SELECT value FROM site_settings WHERE key='watermark_url'");
    const sGlobalWmOn = getOne("SELECT value FROM site_settings WHERE key='wm_on_series'");
    const sUseWm = (ser?.watermark !== 0) && (sGlobalWmOn ? sGlobalWmOn.value !== '0' : true) && (sWmUrl || (sGlobalWm && sGlobalWm.value));
    if (sUseWm) {
      const finalWm = sWmUrl || (sGlobalWm ? sGlobalWm.value : '');
      if (finalWm) {
        const gp = getOne("SELECT value FROM site_settings WHERE key='watermark_position'");
        const go = getOne("SELECT value FROM site_settings WHERE key='watermark_opacity'");
        const gs2 = getOne("SELECT value FROM site_settings WHERE key='watermark_size'");
        return proxyWithWatermark(videoUrl, req, res, {
          url: finalWm, position: ser?.watermark_position || (gp?gp.value:'top-right'),
          opacity: ser?.watermark_opacity || (go?parseFloat(go.value):0.8), size: ser?.watermark_size || (gs2?parseInt(gs2.value):120)
        });
      }
    }
  }

  if (videoUrl.startsWith('/media/') || videoUrl.startsWith('/hls/')) {
    const filePath = path.join(BASE_DIR, videoUrl);
    if (fs.existsSync(filePath)) return res.sendFile(filePath);
    return res.status(404).send('File not found');
  }
  proxyUrl(videoUrl, req, res, 'video/mp4');
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

  // Auth info (no action = login check) — Xtream Codes compatible format
  if (!action) {
    const plan = getOne('SELECT * FROM subscriptions WHERE LOWER(name) = LOWER(?)', [user.subscription]) || {};
    const host = req.get('host') || 'localhost:' + PORT;
    const hostname = host.split(':')[0];
    const port = host.split(':')[1] || (req.protocol === 'https' ? '443' : '80');
    // exp_date must be Unix timestamp (IPTV Smarters requirement)
    let expDate = Math.floor(Date.now() / 1000) + 365 * 86400; // default: 1 year from now
    if (user.expires_at && user.expires_at !== 'Unlimited') {
      const d = new Date(user.expires_at);
      if (!isNaN(d.getTime())) expDate = Math.floor(d.getTime() / 1000);
    }
    const createdTs = user.created_at ? Math.floor(new Date(user.created_at).getTime() / 1000) : Math.floor(Date.now() / 1000);

    return res.json({
      user_info: {
        auth: 1,
        status: 'Active',
        username: user.username,
        password: password,
        message: 'Welcome',
        subscription: user.subscription || 'trial',
        exp_date: String(expDate),
        is_trial: user.subscription === 'trial' ? '1' : '0',
        active_cons: String(getActiveConnectionCount(user.id)),
        created_at: String(createdTs),
        max_connections: String(user.max_connections || 1),
        allowed_output_formats: ['m3u8', 'ts', 'rtmp']
      },
      server_info: {
        url: req.protocol + '://' + hostname,
        port: String(port),
        https_port: String(port),
        server_protocol: req.protocol,
        rtmp_port: '1935',
        timezone: 'UTC',
        timestamp_now: Math.floor(Date.now() / 1000),
        time_now: new Date().toISOString().replace('T', ' ').split('.')[0],
        epg_url: req.protocol + '://' + req.get('host') + '/xmltv.php'
      }
    });
  }

  // Get live channels
  if (action === 'get_live_categories') {
    const cats = getAll("SELECT DISTINCT category FROM channels WHERE is_active = 1 AND name != '__category_placeholder__'");
    const result = cats.map((c, i) => ({
      category_id: String(i + 1),
      category_name: c.category,
      parent_id: 0
    }));
    // Add custom 24/7 channel categories
    const customCats = getAll('SELECT DISTINCT category FROM custom_channels WHERE is_active = 1');
    const existingNames = result.map(r => r.category_name);
    customCats.forEach((cc, i) => {
      const catName = cc.category || '24/7 Channels';
      if (!existingNames.includes(catName)) {
        result.push({ category_id: String(9000 + i), category_name: catName, parent_id: 0 });
        existingNames.push(catName);
      }
    });
    return res.json(result);
  }

  if (action === 'get_live_streams') {
    const channels = getAll("SELECT * FROM channels WHERE is_active = 1 AND name != '__category_placeholder__' ORDER BY sort_order");
    const cats = [...new Set(channels.map(c => c.category))];
    const baseUrl = req.protocol + '://' + req.get('host');
    const result = channels.map(c => {
      // Determine container extension from URL
      const ext = c.stream_url && c.stream_url.includes('.m3u8') ? 'm3u8' : 'ts';
      return {
        num: c.id,
        name: c.name,
        stream_type: 'live',
        stream_id: c.id,
        stream_icon: c.logo_url || '',
        epg_channel_id: c.epg_id || null,
        added: c.created_at ? String(Math.floor(new Date(c.created_at).getTime() / 1000)) : '0',
        is_adult: '0',
        category_id: String(cats.indexOf(c.category) + 1),
        category_ids: [cats.indexOf(c.category) + 1],
        custom_sid: '',
        tv_archive: 0,
        direct_source: c.stream_url || '',
        tv_archive_duration: 0,
        container_extension: ext,
        watermark: c.watermark,
        watermark_url: c.watermark_url || '',
        watermark_position: c.watermark_position || '',
        watermark_opacity: c.watermark_opacity,
        watermark_size: c.watermark_size
      };
    });
    // Add custom 24/7 channels to live streams
    const custom24 = getAll('SELECT * FROM custom_channels WHERE is_active = 1');
    custom24.forEach(cc => {
      const urls = JSON.parse(cc.video_urls || '[]');
      if (urls.length > 0) {
        result.push({
          num: 90000 + cc.id,
          name: cc.name,
          stream_type: 'live',
          stream_id: 90000 + cc.id,
          stream_icon: cc.logo_url || '',
          epg_channel_id: null,
          added: '0',
          is_adult: '0',
          category_id: cc.category || '24/7 Channels',
          category_ids: [cc.category || '24/7 Channels'],
          custom_sid: 'custom_' + cc.id,
          tv_archive: 0,
          direct_source: '',
          tv_archive_duration: 0,
          container_extension: 'ts'
        });
      }
    });
    return res.json(result);
  }

  // Get VOD (movies)
  if (action === 'get_vod_categories') {
    const cats = getAll('SELECT DISTINCT category FROM movies WHERE is_active = 1');
    return res.json(cats.map((c, i) => ({
      category_id: String(i + 100),
      category_name: c.category,
      parent_id: 0
    })));
  }

  if (action === 'get_vod_streams') {
    const movies = getAll('SELECT * FROM movies WHERE is_active = 1');
    const cats = [...new Set(movies.map(m => m.category))];
    return res.json(movies.map(m => ({
      num: m.id,
      name: m.title,
      stream_type: 'movie',
      stream_id: m.id,
      stream_icon: m.poster_url || '',
      rating: String(m.rating || ''),
      rating_5based: String(((m.rating || 0) / 2).toFixed(1)),
      added: m.created_at ? String(Math.floor(new Date(m.created_at).getTime() / 1000)) : '0',
      is_adult: '0',
      category_id: String(cats.indexOf(m.category) + 100),
      category_ids: [cats.indexOf(m.category) + 100],
      container_extension: 'mp4',
      custom_sid: '',
      direct_source: '',
      watermark: m.watermark,
      watermark_url: m.watermark_url || '',
      watermark_position: m.watermark_position || '',
      watermark_opacity: m.watermark_opacity,
      watermark_size: m.watermark_size
    })));
  }

  // Get VOD info (IPTV Smarters needs this)
  if (action === 'get_vod_info') {
    const vodId = req.query.vod_id;
    const movie = getOne('SELECT * FROM movies WHERE id = ?', [vodId]);
    if (!movie) return res.status(404).json({ error: 'Movie not found' });
    return res.json({
      info: {
        movie_image: movie.poster_url || '',
        tmdb_id: String(movie.tmdb_id || ''),
        name: movie.title,
        year: String(movie.year || ''),
        description: movie.description || '',
        plot: movie.description || '',
        cast: movie.cast_list || '',
        director: movie.director || '',
        genre: movie.genre || movie.category || '',
        release_date: movie.year ? movie.year + '-01-01' : '',
        rating: String(movie.rating || ''),
        duration_secs: (movie.duration || 0) * 60,
        duration: movie.duration ? movie.duration + ' min' : '',
        video: {},
        audio: {},
        backdrop_path: movie.backdrop_url ? [movie.backdrop_url] : [],
        container_extension: 'mp4'
      },
      movie_data: {
        stream_id: movie.id,
        name: movie.title,
        added: movie.created_at ? String(Math.floor(new Date(movie.created_at).getTime() / 1000)) : '0',
        category_id: '',
        container_extension: 'mp4',
        custom_sid: '',
        direct_source: ''
      }
    });
  }

  // Get Series
  if (action === 'get_series_categories') {
    const cats = getAll('SELECT DISTINCT category FROM series WHERE is_active = 1');
    return res.json(cats.map((c, i) => ({
      category_id: String(i + 200),
      category_name: c.category,
      parent_id: 0
    })));
  }

  if (action === 'get_series') {
    const series = getAll('SELECT * FROM series WHERE is_active = 1');
    const cats = [...new Set(series.map(s => s.category))];
    return res.json(series.map(s => {
      const epCount = getOne('SELECT COUNT(*) as count FROM episodes WHERE series_id = ?', [s.id]);
      const seasonCount = getOne('SELECT COUNT(DISTINCT season) as c FROM episodes WHERE series_id = ?', [s.id]);
      return {
        num: s.id,
        name: s.title,
        series_id: s.id,
        cover: s.poster_url || '',
        plot: s.description || '',
        cast: '',
        director: '',
        genre: s.category,
        releaseDate: s.year ? s.year.toString() : '',
        last_modified: s.created_at ? String(Math.floor(new Date(s.created_at).getTime() / 1000)) : '0',
        rating: String(s.rating || ''),
        rating_5based: String(((s.rating || 0) / 2).toFixed(1)),
        category_id: String(cats.indexOf(s.category) + 200),
        category_ids: [cats.indexOf(s.category) + 200],
        episode_run_time: '',
        backdrop_path: [],
        youtube_trailer: '',
        seasons: seasonCount ? seasonCount.c : 0
      };
    }));
  }

  if (action === 'get_series_info') {
    const seriesId = req.query.series_id;
    const series = getOne('SELECT * FROM series WHERE id = ?', [seriesId]);
    if (!series) return res.status(404).json({ error: 'Series not found' });
    const episodes = getAll('SELECT * FROM episodes WHERE series_id = ? ORDER BY season, episode_number', [seriesId]);
    const seasonMap = {};
    episodes.forEach(ep => {
      const sKey = String(ep.season);
      if (!seasonMap[sKey]) seasonMap[sKey] = [];
      seasonMap[sKey].push({
        id: String(ep.id),
        episode_num: ep.episode_number,
        title: ep.title,
        container_extension: 'mp4',
        info: {
          movie_image: '',
          plot: ep.description || '',
          releasedate: '',
          rating: 0,
          duration_secs: (ep.duration || 0) * 60,
          duration: ep.duration ? ep.duration + ' min' : '',
          video: {},
          audio: {},
          bitrate: 0,
          season: ep.season
        },
        custom_sid: '',
        added: '',
        season: ep.season,
        direct_source: ''
      });
    });
    return res.json({
      seasons: Object.keys(seasonMap).map(s => ({
        air_date: '',
        episode_count: seasonMap[s].length,
        id: parseInt(s),
        name: 'Season ' + s,
        overview: '',
        season_number: parseInt(s),
        cover: series.poster_url || '',
        cover_big: series.poster_url || ''
      })),
      episodes: seasonMap,
      info: {
        name: series.title,
        cover: series.poster_url || '',
        plot: series.description || '',
        genre: series.genre || series.category || '',
        rating: String(series.rating || ''),
        releaseDate: series.year ? String(series.year) : '',
        cast: series.cast_list || '',
        director: series.director || '',
        episode_run_time: '',
        category_id: '',
        tmdb_id: String(series.tmdb_id || ''),
        backdrop_path: series.backdrop_url ? [series.backdrop_url] : []
      }
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
  const channels = getAll("SELECT * FROM channels WHERE is_active = 1 AND name != '__category_placeholder__' ORDER BY sort_order");
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

  // 24/7 Movie Channel (all movies)
  const movieChannel = getAll('SELECT * FROM movies WHERE is_active = 1 AND video_url IS NOT NULL AND video_url != "" ORDER BY RANDOM()');
  if (movieChannel.length > 0) {
    m3u += `#EXTINF:-1 tvg-name="24/7 Movies" tvg-logo="" group-title="24/7 Channels",🎬 24/7 Movies Channel\n`;
    m3u += `${baseUrl}/live/movies.m3u8?token=${username}:${password}\n`;
  }

  // Custom 24/7 channels
  const customChs = getAll('SELECT * FROM custom_channels WHERE is_active = 1');
  customChs.forEach(cc => {
    const urls = JSON.parse(cc.video_urls || '[]');
    if (urls.length > 0) {
      m3u += `#EXTINF:-1 tvg-name="${cc.name}" tvg-logo="${cc.logo_url || ''}" group-title="${cc.category || '24/7 Channels'}",${cc.name}\n`;
      m3u += `${baseUrl}/live/custom/${cc.id}?username=${username}&password=${password}\n`;
    }
  });

  res.setHeader('Content-Type', 'audio/mpegurl');
  res.setHeader('Content-Disposition', `attachment; filename="${username}_playlist.m3u"`);
  res.send(m3u);
});

// ===== 24/7 MOVIE CHANNEL =====
// Default 24/7 channel — plays all movies in rotation
app.get('/live/movies.m3u8', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).send('Token required');
  const [username, password] = token.split(':');
  const user = getOne('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password || '', user.password)) return res.status(401).send('Invalid');

  const movies = getAll('SELECT * FROM movies WHERE is_active = 1 AND video_url IS NOT NULL AND video_url != ""');
  if (movies.length === 0) return res.status(404).send('No movies');

  const now = Math.floor(Date.now() / 1000);
  const avgDuration = 7200;
  const currentIndex = Math.floor(now / avgDuration) % movies.length;
  const currentMovie = movies[currentIndex];

  res.redirect(currentMovie.video_url);
});

// Custom 24/7 channel — plays video URLs in rotation
app.get('/live/custom/:channelId', (req, res) => {
  const { channelId } = req.params;
  const cleanId = channelId.replace(/\.(m3u8|mp4|ts)$/, '');

  // Auth via query params
  const { username, password: pass } = req.query;
  if (username && pass) {
    const user = getOne('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !bcrypt.compareSync(pass, user.password)) return res.status(401).send('Invalid');
  }

  const channel = getOne('SELECT * FROM custom_channels WHERE id = ? AND is_active = 1', [cleanId]);
  if (!channel) return res.status(404).send('Channel not found');

  const urls = JSON.parse(channel.video_urls || '[]').filter(u => u && u.trim());
  if (urls.length === 0) return res.status(404).send('No videos in this channel');

  // If index specified, play that video. Otherwise rotate by time (3hr fallback for external players)
  let currentIndex;
  if (req.query.index !== undefined) {
    currentIndex = parseInt(req.query.index) % urls.length;
  } else {
    const now = Math.floor(Date.now() / 1000);
    currentIndex = Math.floor(now / 10800) % urls.length;
  }
  const currentUrl = urls[currentIndex];

  // Return info header so player knows total videos and next index
  res.setHeader('X-Total-Videos', String(urls.length));
  res.setHeader('X-Current-Index', String(currentIndex));
  res.setHeader('X-Next-Index', String((currentIndex + 1) % urls.length));
  res.setHeader('Access-Control-Expose-Headers', 'X-Total-Videos,X-Current-Index,X-Next-Index');

  // Check FFmpeg watermark for custom 24/7 channels
  const ccFfmpeg = getOne("SELECT value FROM site_settings WHERE key='wm_ffmpeg'");
  if (ccFfmpeg && ccFfmpeg.value === '1') {
    const wmUrl = channel.watermark_url || '';
    const globalWm = getOne("SELECT value FROM site_settings WHERE key='watermark_url'");
    const globalWmOn = getOne("SELECT value FROM site_settings WHERE key='wm_on_channels'");
    const useWm = channel.watermark !== 0 && (globalWmOn ? globalWmOn.value !== '0' : true) && (wmUrl || (globalWm && globalWm.value));
    if (useWm) {
      const finalWmUrl = wmUrl || (globalWm ? globalWm.value : '');
      if (finalWmUrl) {
        const gp = getOne("SELECT value FROM site_settings WHERE key='watermark_position'");
        const go = getOne("SELECT value FROM site_settings WHERE key='watermark_opacity'");
        const gs = getOne("SELECT value FROM site_settings WHERE key='watermark_size'");
        return proxyWithWatermark(currentUrl, req, res, {
          url: finalWmUrl,
          position: (gp ? gp.value : 'top-right'),
          opacity: (go ? parseFloat(go.value) : 0.8),
          size: (gs ? parseInt(gs.value) : 120)
        });
      }
    }
  }

  // If URL is m3u8, redirect. Otherwise proxy.
  if (currentUrl.includes('.m3u8')) {
    return res.redirect(currentUrl);
  }
  proxyUrl(currentUrl, req, res, 'video/mp4');
});

// ===== CUSTOM 24/7 CHANNELS API =====
app.get('/api/admin/custom-channels', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const channels = getAll('SELECT * FROM custom_channels ORDER BY id');
  res.json(channels.map(c => ({ ...c, video_urls: JSON.parse(c.video_urls || '[]') })));
});

app.post('/api/admin/custom-channels', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, category, description, logo_url, video_urls } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const urls = Array.isArray(video_urls) ? video_urls : [];
  run('INSERT INTO custom_channels (name, category, description, logo_url, video_urls) VALUES (?, ?, ?, ?, ?)',
    [name, category || '24/7 Channels', description || '', logo_url || '', JSON.stringify(urls)]);
  res.json({ message: 'Custom channel created' });
});

app.put('/api/admin/custom-channels/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, category, description, logo_url, video_urls, is_active } = req.body;
  run('UPDATE custom_channels SET name=?, category=?, description=?, logo_url=?, video_urls=?, is_active=? WHERE id=?', [
    name, category || '24/7 Channels', description || '', logo_url || '',
    JSON.stringify(Array.isArray(video_urls) ? video_urls : []),
    is_active !== undefined ? is_active : 1,
    req.params.id
  ]);
  res.json({ message: 'Custom channel updated' });
});

app.delete('/api/admin/custom-channels/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  run('DELETE FROM custom_channels WHERE id = ?', [req.params.id]);
  res.json({ message: 'Custom channel deleted' });
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

// ===== AUTO-EXPIRE SUBSCRIPTIONS =====
function checkExpiredUsers() {
  const now = new Date().toISOString();
  const expired = getAll('SELECT id, username, expires_at FROM users WHERE is_active = 1 AND expires_at IS NOT NULL AND expires_at != "Unlimited" AND expires_at < ?', [now]);
  if (expired.length > 0) {
    expired.forEach(u => {
      run('UPDATE users SET is_active = 0 WHERE id = ?', [u.id]);
      console.log(`⏰ Auto-expired user: ${u.username} (expired: ${u.expires_at})`);
    });
  }
}
// Check every 5 minutes
setInterval(checkExpiredUsers, 5 * 60 * 1000);

// ===== EPG (Electronic Program Guide) =====
// Simple XMLTV EPG generator for IPTV Smarters
app.get('/xmltv.php', (req, res) => {
  const channels = getAll("SELECT * FROM channels WHERE is_active = 1 AND name != '__category_placeholder__' ORDER BY sort_order");
  const now = new Date();

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<!DOCTYPE tv SYSTEM "xmltv.dtd">\n';
  xml += '<tv generator-info-name="IPTV Learning System">\n';

  // Channel definitions
  channels.forEach(ch => {
    xml += `  <channel id="${ch.epg_id || ch.id}">\n`;
    xml += `    <display-name>${escXml(ch.name)}</display-name>\n`;
    if (ch.logo_url) xml += `    <icon src="${escXml(ch.logo_url)}" />\n`;
    xml += `  </channel>\n`;
  });

  // Programs — generate 24h of programs for each channel
  const genres = ['News', 'Sports', 'Movie', 'Series', 'Documentary', 'Entertainment', 'Kids', 'Music', 'Talk Show', 'Reality'];
  const programs = ['Morning Show', 'News Update', 'Sports Center', 'Movie Time', 'Series Marathon', 'Documentary Hour', 'Kids Zone', 'Music Hits', 'Talk Tonight', 'Reality Check', 'Live Coverage', 'Special Report', 'Weekend Edition', 'Prime Time', 'Late Night'];

  channels.forEach(ch => {
    let t = new Date(now);
    t.setHours(0, 0, 0, 0);
    for (let i = 0; i < 24; i++) {
      const start = new Date(t.getTime() + i * 3600000);
      const stop = new Date(start.getTime() + 3600000);
      const prog = programs[(ch.id + i) % programs.length];
      const genre = genres[(ch.id + i) % genres.length];
      xml += `  <programme start="${epgDate(start)}" stop="${epgDate(stop)}" channel="${ch.epg_id || ch.id}">\n`;
      xml += `    <title>${escXml(prog)}</title>\n`;
      xml += `    <desc>${escXml(ch.name + ' - ' + genre + ' Program')}</desc>\n`;
      xml += `    <category>${escXml(genre)}</category>\n`;
      xml += `  </programme>\n`;
    }
  });

  xml += '</tv>';
  res.setHeader('Content-Type', 'application/xml');
  res.send(xml);
});

function epgDate(d) {
  return d.getFullYear() +
    String(d.getMonth()+1).padStart(2,'0') +
    String(d.getDate()).padStart(2,'0') +
    String(d.getHours()).padStart(2,'0') +
    String(d.getMinutes()).padStart(2,'0') +
    String(d.getSeconds()).padStart(2,'0') + ' +0000';
}
function escXml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ===== TMDB INTEGRATION =====
// Fetch movie/series posters and info from TMDB
function getTmdbKey() { return process.env.TMDB_API_KEY || ''; }

app.post('/api/admin/tmdb/fetch-posters', async (req, res) => {
  const TMDB_KEY = getTmdbKey();
  if (!TMDB_KEY) return res.status(400).json({ error: 'Set TMDB_API_KEY env variable first. Get free key: https://www.themoviedb.org/settings/api (sign up -> Settings -> API)' });

  // Fetch ALL movies & series (not just missing posters) to get full data
  const movies = getAll('SELECT id, title, year, tmdb_id FROM movies');
  const seriesList = getAll('SELECT id, title, year, tmdb_id FROM series');
  let updated = 0;
  const errors = [];

  // Process movies
  for (const m of movies) {
    try {
      // Search for movie
      const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(m.title)}&year=${m.year||''}`;
      const searchData = await fetchJson(searchUrl);
      if (!searchData.results || !searchData.results[0]) continue;
      const tmdbId = m.tmdb_id || searchData.results[0].id;
      const r = searchData.results[0];

      // Get detailed info with credits (cast & crew)
      const detailUrl = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}&append_to_response=credits`;
      const detail = await fetchJson(detailUrl);

      const poster = detail.poster_path ? 'https://image.tmdb.org/t/p/w500' + detail.poster_path : '';
      const backdrop = detail.backdrop_path ? 'https://image.tmdb.org/t/p/w780' + detail.backdrop_path : '';
      const castArr = (detail.credits?.cast || []).slice(0, 10).map(c => c.name);
      const director = (detail.credits?.crew || []).find(c => c.job === 'Director');
      const genres = (detail.genres || []).map(g => g.name).join(', ');

      run(`UPDATE movies SET poster_url=?, description=?, rating=?, cast_list=?, director=?, genre=?, backdrop_url=?, tmdb_id=?, duration=CASE WHEN duration IS NULL OR duration=0 THEN ? ELSE duration END WHERE id=?`, [
        poster || null,
        detail.overview || '',
        detail.vote_average || 0,
        castArr.join(', ') || '',
        director ? director.name : '',
        genres || '',
        backdrop || '',
        tmdbId,
        detail.runtime || 0,
        m.id
      ]);
      updated++;
    } catch(e) { errors.push(m.title + ': ' + e.message); }
    await new Promise(r => setTimeout(r, 300)); // Rate limit
  }

  // Process series
  for (const s of seriesList) {
    try {
      const searchUrl = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_KEY}&query=${encodeURIComponent(s.title)}`;
      const searchData = await fetchJson(searchUrl);
      if (!searchData.results || !searchData.results[0]) continue;
      const tmdbId = s.tmdb_id || searchData.results[0].id;

      const detailUrl = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_KEY}&append_to_response=credits`;
      const detail = await fetchJson(detailUrl);

      const poster = detail.poster_path ? 'https://image.tmdb.org/t/p/w500' + detail.poster_path : '';
      const backdrop = detail.backdrop_path ? 'https://image.tmdb.org/t/p/w780' + detail.backdrop_path : '';
      const castArr = (detail.credits?.cast || []).slice(0, 10).map(c => c.name);
      const creator = (detail.created_by || []).map(c => c.name).join(', ');
      const genres = (detail.genres || []).map(g => g.name).join(', ');

      run(`UPDATE series SET poster_url=?, description=?, rating=?, cast_list=?, director=?, genre=?, backdrop_url=?, tmdb_id=? WHERE id=?`, [
        poster || null,
        detail.overview || '',
        detail.vote_average || 0,
        castArr.join(', ') || '',
        creator || '',
        genres || '',
        backdrop || '',
        tmdbId,
        s.id
      ]);
      updated++;
    } catch(e) { errors.push(s.title + ': ' + e.message); }
    await new Promise(r => setTimeout(r, 300));
  }

  res.json({ message: `Updated ${updated}/${movies.length + seriesList.length} from TMDB (with cast, director, genres)`, updated, errors: errors.slice(0, 5) });
});

// Fetch single movie/series info from TMDB
app.get('/api/admin/tmdb/search', async (req, res) => {
  const TMDB_KEY = getTmdbKey();
  if (!TMDB_KEY) return res.status(400).json({ error: 'Set TMDB_API_KEY env variable' });
  const { query, type, year } = req.query;
  if (!query) return res.status(400).json({ error: 'query parameter required' });
  try {
    const t = type === 'series' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/search/${t}?api_key=${TMDB_KEY}&query=${encodeURIComponent(query)}&year=${year||''}`;
    const data = await fetchJson(url);
    const results = (data.results || []).slice(0, 10).map(r => ({
      title: r.title || r.name,
      year: (r.release_date || r.first_air_date || '').split('-')[0],
      overview: r.overview,
      rating: r.vote_average,
      poster: r.poster_path ? 'https://image.tmdb.org/t/p/w500' + r.poster_path : '',
      backdrop: r.backdrop_path ? 'https://image.tmdb.org/t/p/w780' + r.backdrop_path : '',
      tmdb_id: r.id
    }));
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'IPTV-Learning/1.0' } }, (r) => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

// ===== CHANGE ADMIN PASSWORD =====
app.post('/api/admin/change-password', (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) return res.status(400).json({ error: 'Both old and new password required' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const user = getOne('SELECT * FROM users WHERE id = ?', [admin.id]);
  if (!user || !bcrypt.compareSync(old_password, user.password)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  run('UPDATE users SET password = ? WHERE id = ?', [hash, admin.id]);
  res.json({ message: 'Password changed successfully' });
});

// ===== DATABASE BACKUP & RESTORE =====
// Download database file
app.get('/api/admin/backup/download', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const dbPath = path.join(BASE_DIR, 'iptv.db');
  if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'Database file not found' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename=iptv_backup_' + new Date().toISOString().split('T')[0] + '.db');
  res.sendFile(dbPath);
});

// Upload/restore database file
app.post('/api/admin/backup/restore', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('octet-stream') && !contentType.includes('sqlite')) {
    return res.status(400).json({ error: 'Send database file as binary (application/octet-stream)' });
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    if (buf.length < 100) return res.status(400).json({ error: 'File too small to be a valid database' });

    // Verify it's a valid SQLite file (starts with "SQLite format 3")
    const header = buf.slice(0, 16).toString('ascii');
    if (!header.startsWith('SQLite format 3')) {
      return res.status(400).json({ error: 'Not a valid SQLite database file' });
    }

    const dbPath = path.join(BASE_DIR, 'iptv.db');
    // Backup current DB first
    try {
      if (fs.existsSync(dbPath)) {
        fs.copyFileSync(dbPath, dbPath + '.before_restore');
      }
    } catch(e) {}

    // Write uploaded DB
    try {
      fs.writeFileSync(dbPath, buf);
      res.json({ message: 'Database restored! Restart the server to load the new data.', size: buf.length });
    } catch(e) {
      res.status(500).json({ error: 'Failed to write database: ' + e.message });
    }
  });
});

// ===== EXPORT USERS CSV (server-side) =====
app.get('/api/admin/users/export/csv', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Auth required' });
  const jwt = require('jsonwebtoken');
  try { jwt.verify(token, process.env.JWT_SECRET || 'iptv-learning-secret-key-2024'); } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }

  const users = getAll('SELECT * FROM users ORDER BY id');
  let csv = 'ID,Username,Role,Subscription,Expires,MaxConnections,Status,LastLogin\n';
  users.forEach(u => {
    csv += `${u.id},"${u.username}",${u.role},${u.subscription},${u.expires_at||'Unlimited'},${u.max_connections||1},${u.is_active?'Active':'Blocked'},"${u.last_login||'Never'}"\n`;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=users.csv');
  res.send(csv);
});

// Root redirect
app.get('/', (req, res) => res.redirect('/admin'));

// ===== SITE SETTINGS API =====
function requireAdmin(req, res) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) { res.status(401).json({ error: 'Auth required' }); return null; }
  const jwt = require('jsonwebtoken');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'iptv-learning-secret-key-2024');
    if (decoded.role !== 'admin') { res.status(403).json({ error: 'Admin only' }); return null; }
    return decoded;
  } catch { res.status(401).json({ error: 'Invalid token' }); return null; }
}

// GET /api/admin/settings — returns all settings
app.get('/api/admin/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = getAll('SELECT key, value FROM site_settings', []);
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

// PUT /api/admin/settings — updates a setting
app.put('/api/admin/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  run('INSERT OR REPLACE INTO site_settings (key, value) VALUES (?, ?)', [key, String(value ?? '')]);
  res.json({ message: 'Setting updated', key, value });
});

// Admin: Kick user (disconnect all their streams)
app.post('/api/admin/connections/kick', (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const conns = activeConnections.get(Number(userId));
  if (conns) {
    activeConnections.delete(Number(userId));
    auditLog(admin.id, admin.username || 'admin', 'kick_user', `Kicked user ID ${userId}`, req, 'medium');
    res.json({ message: 'User kicked', disconnected: conns.size });
  } else {
    res.json({ message: 'User has no active connections', disconnected: 0 });
  }
});

// GET /api/settings/public — public branding settings (no auth)
app.get('/api/settings/public', (req, res) => {
  const publicKeys = ['site_name', 'logo_url', 'watermark_url', 'watermark_position', 'watermark_opacity'];
  const rows = getAll('SELECT key, value FROM site_settings WHERE key IN (' + publicKeys.map(() => '?').join(',') + ')', publicKeys);
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

// ===== WATERMARK PREVIEW =====
// GET /api/admin/watermark-preview — HTML preview page with watermark overlay
app.get('/api/admin/watermark-preview', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = getAll('SELECT key, value FROM site_settings', []);
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });

  const position = s.watermark_position || 'top-right';
  const opacity = parseFloat(s.watermark_opacity) || 0.5;
  const watermarkUrl = s.watermark_url || '';
  const siteName = s.site_name || 'IPTV Pro';

  const posStyles = {
    'top-right':    'top:10px; right:10px;',
    'top-left':     'top:10px; left:10px;',
    'bottom-right': 'bottom:10px; right:10px;',
    'bottom-left':  'bottom:10px; left:10px;',
    'center':       'top:50%; left:50%; transform:translate(-50%,-50%);'
  };
  const posStyle = posStyles[position] || posStyles['top-right'];

  const watermarkHtml = watermarkUrl
    ? `<img src="${watermarkUrl}" style="max-width:150px; max-height:80px;" />`
    : `<span style="color:white; font-size:18px; font-weight:bold; text-shadow:1px 1px 3px #000;">${siteName}</span>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head><title>Watermark Preview</title>
<style>
  body { margin:0; background:#000; display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; font-family:sans-serif; color:#fff; }
  .container { position:relative; width:640px; height:360px; background:#111; border:1px solid #333; }
  video { width:100%; height:100%; object-fit:cover; }
  .watermark { position:absolute; ${posStyle} opacity:${opacity}; pointer-events:none; z-index:10; }
  .info { margin-top:16px; font-size:13px; color:#aaa; }
</style>
</head>
<body>
  <h2>Watermark Preview — ${siteName}</h2>
  <div class="container">
    <video autoplay muted loop playsinline src="https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8" onerror="this.style.display='none'"></video>
    <div class="watermark">${watermarkHtml}</div>
  </div>
  <div class="info">Position: ${position} | Opacity: ${opacity}</div>
</body>
</html>`);
});

// ===== M3U IMPORT FROM URL FOR RESTREAM =====
// POST /api/admin/import-restream — fetch M3U from URL and return parsed channel list
app.post('/api/admin/import-restream', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const content = await new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0' }
      };
      const reqM3u = client.request(options, (response) => {
        if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          const redirectUrl = response.headers.location.startsWith('http')
            ? response.headers.location
            : new URL(response.headers.location, url).href;
          const client2 = redirectUrl.startsWith('https') ? https : http;
          client2.get(redirectUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r2) => {
            let d = ''; r2.on('data', c => d += c); r2.on('end', () => resolve(d)); r2.on('error', reject);
          }).on('error', reject);
          return;
        }
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => resolve(data));
        response.on('error', reject);
      });
      reqM3u.on('error', reject);
      reqM3u.setTimeout(15000, () => { reqM3u.destroy(); reject(new Error('Request timed out')); });
      reqM3u.end();
    });

    const lines = content.split('\n').map(l => l.trim()).filter(l => l);
    const channels = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXTINF:')) {
        const info = lines[i];
        const streamUrl = (lines[i + 1] && !lines[i + 1].startsWith('#')) ? lines[i + 1] : '';
        if (!streamUrl) continue;
        const nameMatch = info.match(/,(.+)$/);
        const name = nameMatch ? nameMatch[1].trim() : 'Unknown';
        const groupMatch = info.match(/group-title="([^"]*)"/);
        const category = groupMatch ? groupMatch[1] : '';
        channels.push({ name, url: streamUrl, category });
        i++;
      }
    }
    res.json({ total: channels.length, channels });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch M3U: ' + e.message });
  }
});

// Start
async function start() {
  await init();

  // HTTPS support — if cert files exist, start HTTPS too
  const SSL_DIR = path.join(BASE_DIR, 'ssl');
  const certPath = path.join(SSL_DIR, 'cert.pem');
  const keyPath = path.join(SSL_DIR, 'key.pem');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const httpsServer = https.createServer({
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath)
      }, app);
      const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
      httpsServer.listen(HTTPS_PORT, () => {
        console.log(`   🔒 HTTPS:       https://localhost:${HTTPS_PORT}`);
      });
    } catch(e) { console.error('HTTPS setup failed:', e.message); }
  }

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

    // Check expired users on startup
    checkExpiredUsers();

    // Start all enabled restreams
    restream.startAllEnabled();

    // ===== DATABASE BACKUP (every 5 minutes, keep max 50) =====
    const BACKUP_DIR = path.join(BASE_DIR, 'backups');
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    setInterval(() => {
      try {
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const stamp = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
        const dest = path.join(BACKUP_DIR, `iptv_${stamp}.db`);
        const src = path.join(BASE_DIR, 'iptv.db');
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
          // Prune oldest backups — keep max 50
          const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('iptv_') && f.endsWith('.db'))
            .map(f => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
            .sort((a, b) => a.mtime - b.mtime);
          while (files.length > 50) {
            const oldest = files.shift();
            try { fs.unlinkSync(path.join(BACKUP_DIR, oldest.name)); } catch(e) {}
          }
        }
      } catch(e) { console.error('Backup error:', e.message); }
    }, 5 * 60 * 1000);

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
