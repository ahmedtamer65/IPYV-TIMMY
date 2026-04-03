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
        active_cons: 0,
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
      direct_source: c.stream_url || '',
      backup_url: c.backup_url || '',
      backup_url2: c.backup_url2 || ''
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
      direct_source: m.video_url || '',
      backup_url: m.backup_url || '',
      backup_url2: m.backup_url2 || '',
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
    const seasonMap = {};
    episodes.forEach(ep => {
      if (!seasonMap[ep.season]) seasonMap[ep.season] = [];
      seasonMap[ep.season].push({
        id: ep.id,
        episode_num: ep.episode_number,
        title: ep.title,
        container_extension: 'mp4',
        info: { duration_secs: (ep.duration || 0) * 60, plot: ep.description || '' },
        direct_source: ep.video_url || '',
        backup_url: ep.backup_url || '',
        backup_url2: ep.backup_url2 || ''
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

  // Live channels
  channels.forEach(ch => {
    if (!ch.stream_url) return;
    const logo = ch.logo_url || '';
    m3u += `#EXTINF:-1 tvg-id="${ch.epg_id||''}" tvg-name="${ch.name}" tvg-logo="${logo}" group-title="${ch.category}",${ch.name}\n`;
    m3u += `${ch.stream_url}\n`;
  });

  // Movies as VOD
  movies.forEach(mv => {
    if (!mv.video_url) return;
    m3u += `#EXTINF:-1 tvg-name="${mv.title}" tvg-logo="${mv.poster_url||''}" group-title="VOD | ${mv.category}",${mv.title} (${mv.year||''})\n`;
    m3u += `${mv.video_url}\n`;
  });

  // Series episodes
  seriesList.forEach(s => {
    const episodes = getAll('SELECT * FROM episodes WHERE series_id = ? AND is_active = 1 ORDER BY season, episode_number', [s.id]);
    episodes.forEach(ep => {
      if (!ep.video_url) return;
      m3u += `#EXTINF:-1 tvg-name="${s.title} S${String(ep.season).padStart(2,'0')}E${String(ep.episode_number).padStart(2,'0')}" tvg-logo="${s.poster_url||''}" group-title="Series | ${s.title}",${s.title} - S${String(ep.season).padStart(2,'0')}E${String(ep.episode_number).padStart(2,'0')} - ${ep.title}\n`;
      m3u += `${ep.video_url}\n`;
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
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
