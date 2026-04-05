const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { run, getOne, getAll } = require('../db');
const { authenticate, adminOnly } = require('../middleware/auth');

// Media upload setup
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const MEDIA_DIR = path.join(BASE_DIR, 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const subDir = file.mimetype.startsWith('video/') ? 'videos' : 'images';
    const dir = path.join(MEDIA_DIR, subDir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = file.originalname.replace(ext, '').replace(/[^a-zA-Z0-9_\-]/g, '_');
    cb(null, Date.now() + '_' + name + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2GB max

const router = express.Router();
router.use(authenticate, adminOnly);

// ===== STATS =====
router.get('/stats', (req, res) => {
  const c = (sql) => (getOne(sql, []) || {})['COUNT(*)'] || (getOne(sql, []) || {}).count || 0;
  const totalUsers = (getOne('SELECT COUNT(*) as count FROM users WHERE role = "user"', []) || {}).count || 0;
  const activeUsers = (getOne('SELECT COUNT(*) as count FROM users WHERE is_active = 1 AND role = "user"', []) || {}).count || 0;
  const totalChannels = (getOne('SELECT COUNT(*) as count FROM channels', []) || {}).count || 0;
  const totalMovies = (getOne('SELECT COUNT(*) as count FROM movies', []) || {}).count || 0;
  const totalSeries = (getOne('SELECT COUNT(*) as count FROM series', []) || {}).count || 0;
  const totalEpisodes = (getOne('SELECT COUNT(*) as count FROM episodes', []) || {}).count || 0;
  const subscriptionStats = getAll('SELECT subscription, COUNT(*) as count FROM users WHERE role = "user" GROUP BY subscription') || [];
  const recentUsers = getAll('SELECT id, username, subscription, is_active, created_at, last_login FROM users WHERE role = "user" ORDER BY id DESC LIMIT 10') || [];
  res.json({ totalUsers, activeUsers, totalChannels, totalMovies, totalSeries, totalEpisodes, subscriptionStats, recentUsers });
});

// ===== USERS =====
router.get('/users', (req, res) => {
  res.json(getAll('SELECT id, username, role, subscription, expires_at, max_connections, is_active, created_at, last_login, notes FROM users ORDER BY id DESC'));
});

router.post('/users', (req, res) => {
  try {
    const { username, password, role, subscription, expires_at, max_connections, notes } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    const existing = getOne('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) return res.status(400).json({ error: 'Username already exists' });
    const hash = bcrypt.hashSync(password || '1234', 10);
    const result = run('INSERT INTO users (username, password, role, subscription, expires_at, max_connections, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [username, hash, role || 'user', subscription || 'trial', expires_at || null, max_connections || 1, notes || null]);
    res.json({ id: result.lastInsertRowid, message: 'User created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/users/:id', (req, res) => {
  try {
    const { username, role, subscription, expires_at, is_active, max_connections, notes } = req.body;
    const user = getOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    run('UPDATE users SET username=?, role=?, subscription=?, expires_at=?, is_active=?, max_connections=?, notes=? WHERE id=?', [
      username ?? user.username, role ?? user.role, subscription ?? user.subscription,
      expires_at ?? user.expires_at, is_active ?? user.is_active,
      max_connections ?? user.max_connections, notes ?? user.notes, req.params.id
    ]);
    res.json({ message: 'User updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/users/:id/password', (req, res) => {
  const { password } = req.body;
  const hash = bcrypt.hashSync(password, 10);
  run('UPDATE users SET password = ? WHERE id = ?', [hash, req.params.id]);
  res.json({ message: 'Password updated' });
});

router.delete('/users/:id', (req, res) => {
  run('DELETE FROM users WHERE id = ? AND role != "admin"', [req.params.id]);
  res.json({ message: 'User deleted' });
});

// ===== CATEGORIES =====
// Get all categories with channel counts
router.get('/categories', (req, res) => {
  const cats = getAll(`
    SELECT category, COUNT(*) as channel_count,
    SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_count
    FROM channels GROUP BY category ORDER BY category
  `);
  res.json(cats);
});

// Add new category (creates a placeholder so it shows up even empty)
router.post('/categories', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Category name required' });
  // Check if category already exists
  const existing = getOne('SELECT category FROM channels WHERE category = ? LIMIT 1', [name.trim()]);
  if (existing) return res.status(400).json({ error: 'Category already exists' });
  // Insert a hidden placeholder channel to "create" the category
  run('INSERT INTO channels (name, category, stream_url, is_active, sort_order) VALUES (?, ?, ?, ?, ?)',
    ['__category_placeholder__', name.trim(), '', 0, 99999]);
  res.json({ message: 'Category created', category: name.trim() });
});

// Rename category — updates all channels in that category
router.put('/categories/:oldName', (req, res) => {
  const oldName = decodeURIComponent(req.params.oldName);
  const { newName } = req.body;
  if (!newName || !newName.trim()) return res.status(400).json({ error: 'New name required' });
  const count = getOne('SELECT COUNT(*) as c FROM channels WHERE category = ?', [oldName]);
  if (!count || count.c === 0) return res.status(404).json({ error: 'Category not found' });
  run('UPDATE channels SET category = ? WHERE category = ?', [newName.trim(), oldName]);
  // Also update movies & series with same category name
  run('UPDATE movies SET category = ? WHERE category = ?', [newName.trim(), oldName]);
  run('UPDATE series SET category = ? WHERE category = ?', [newName.trim(), oldName]);
  res.json({ message: `Renamed "${oldName}" → "${newName.trim()}", ${count.c} channels updated` });
});

// Delete category — move channels to another category, NOT delete them
router.delete('/categories/:name', (req, res) => {
  const catName = decodeURIComponent(req.params.name);
  const moveTo = req.query.moveTo || 'general';

  const count = getOne('SELECT COUNT(*) as c FROM channels WHERE category = ?', [catName]);
  if (!count || count.c === 0) return res.status(404).json({ error: 'Category not found or empty' });

  // Move all channels to the target category
  run('UPDATE channels SET category = ? WHERE category = ?', [moveTo, catName]);

  // Remove any placeholder channels
  run('DELETE FROM channels WHERE name = "__category_placeholder__" AND category = ?', [moveTo]);

  res.json({ message: `Deleted "${catName}", ${count.c} channels moved to "${moveTo}"` });
});

// ===== CHANNELS =====
router.get('/channels', (req, res) => {
  res.json(getAll('SELECT * FROM channels WHERE name != "__category_placeholder__" ORDER BY sort_order ASC'));
});

router.post('/channels', (req, res) => {
  try {
    const { name, category, stream_url, backup_url, backup_url2, logo_url, sort_order } = req.body;
    const result = run('INSERT INTO channels (name, category, stream_url, backup_url, backup_url2, logo_url, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [name, category || 'general', stream_url || '', backup_url || '', backup_url2 || '', logo_url || '', sort_order || 0]);
    res.json({ id: result.lastInsertRowid, message: 'Channel created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/channels/:id', (req, res) => {
  const { name, category, stream_url, backup_url, backup_url2, logo_url, is_active, sort_order } = req.body;
  const ch = getOne('SELECT * FROM channels WHERE id = ?', [req.params.id]);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  run('UPDATE channels SET name=?, category=?, stream_url=?, backup_url=?, backup_url2=?, logo_url=?, is_active=?, sort_order=? WHERE id=?', [
    name ?? ch.name, category ?? ch.category, stream_url ?? ch.stream_url,
    backup_url ?? ch.backup_url, backup_url2 ?? ch.backup_url2,
    logo_url ?? ch.logo_url, is_active ?? ch.is_active, sort_order ?? ch.sort_order, req.params.id
  ]);
  res.json({ message: 'Channel updated' });
});

router.delete('/channels/:id', (req, res) => {
  run('DELETE FROM channels WHERE id = ?', [req.params.id]);
  res.json({ message: 'Channel deleted' });
});

// ===== MOVIES =====
router.get('/movies', (req, res) => {
  res.json(getAll('SELECT * FROM movies ORDER BY id DESC'));
});

router.post('/movies', (req, res) => {
  try {
    const { title, description, category, poster_url, video_url, duration, year, rating, cast_list, director, genre, backdrop_url } = req.body;
    const result = run('INSERT INTO movies (title, description, category, poster_url, video_url, duration, year, rating, cast_list, director, genre, backdrop_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [title, description, category || 'general', poster_url || '', video_url || '', duration, year, rating, cast_list || '', director || '', genre || '', backdrop_url || '']);
    res.json({ id: result.lastInsertRowid, message: 'Movie created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/movies/:id', (req, res) => {
  const { title, description, category, poster_url, video_url, duration, year, rating, is_active, cast_list, director, genre, backdrop_url } = req.body;
  const mv = getOne('SELECT * FROM movies WHERE id = ?', [req.params.id]);
  if (!mv) return res.status(404).json({ error: 'Movie not found' });
  run('UPDATE movies SET title=?, description=?, category=?, poster_url=?, video_url=?, duration=?, year=?, rating=?, is_active=?, cast_list=?, director=?, genre=?, backdrop_url=? WHERE id=?', [
    title ?? mv.title, description ?? mv.description, category ?? mv.category,
    poster_url ?? mv.poster_url, video_url ?? mv.video_url, duration ?? mv.duration,
    year ?? mv.year, rating ?? mv.rating, is_active ?? mv.is_active,
    cast_list ?? mv.cast_list, director ?? mv.director, genre ?? mv.genre,
    backdrop_url ?? mv.backdrop_url, req.params.id
  ]);
  res.json({ message: 'Movie updated' });
});

router.delete('/movies/:id', (req, res) => {
  run('DELETE FROM movies WHERE id = ?', [req.params.id]);
  res.json({ message: 'Movie deleted' });
});

// ===== SERIES =====
router.get('/series', (req, res) => {
  const series = getAll('SELECT * FROM series ORDER BY id DESC');
  series.forEach(s => {
    s.episode_count = getOne('SELECT COUNT(*) as count FROM episodes WHERE series_id = ?', [s.id]).count;
  });
  res.json(series);
});

router.post('/series', (req, res) => {
  try {
    const { title, description, category, poster_url, total_seasons, year, rating, cast_list, director, genre, backdrop_url } = req.body;
    const result = run('INSERT INTO series (title, description, category, poster_url, total_seasons, year, rating, cast_list, director, genre, backdrop_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [title, description, category || 'drama', poster_url || '', total_seasons || 1, year, rating, cast_list || '', director || '', genre || '', backdrop_url || '']);
    res.json({ id: result.lastInsertRowid, message: 'Series created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/series/:id', (req, res) => {
  const { title, description, category, poster_url, total_seasons, year, rating, is_active, cast_list, director, genre, backdrop_url } = req.body;
  const s = getOne('SELECT * FROM series WHERE id = ?', [req.params.id]);
  if (!s) return res.status(404).json({ error: 'Series not found' });
  run('UPDATE series SET title=?, description=?, category=?, poster_url=?, total_seasons=?, year=?, rating=?, is_active=?, cast_list=?, director=?, genre=?, backdrop_url=? WHERE id=?', [
    title ?? s.title, description ?? s.description, category ?? s.category,
    poster_url ?? s.poster_url, total_seasons ?? s.total_seasons,
    year ?? s.year, rating ?? s.rating, is_active ?? s.is_active,
    cast_list ?? s.cast_list, director ?? s.director, genre ?? s.genre,
    backdrop_url ?? s.backdrop_url, req.params.id
  ]);
  res.json({ message: 'Series updated' });
});

router.delete('/series/:id', (req, res) => {
  run('DELETE FROM episodes WHERE series_id = ?', [req.params.id]);
  run('DELETE FROM series WHERE id = ?', [req.params.id]);
  res.json({ message: 'Series and episodes deleted' });
});

// ===== EPISODES =====
router.get('/series/:id/episodes', (req, res) => {
  res.json(getAll('SELECT * FROM episodes WHERE series_id = ? ORDER BY season, episode_number', [req.params.id]));
});

router.post('/series/:id/episodes', (req, res) => {
  try {
    const { season, episode_number, title, description, video_url, duration } = req.body;
    const result = run('INSERT INTO episodes (series_id, season, episode_number, title, description, video_url, duration) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.params.id, season || 1, episode_number, title, description || '', video_url || '', duration]);
    res.json({ id: result.lastInsertRowid, message: 'Episode created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/episodes/:id', (req, res) => {
  const { season, episode_number, title, description, video_url, duration, is_active } = req.body;
  const ep = getOne('SELECT * FROM episodes WHERE id = ?', [req.params.id]);
  if (!ep) return res.status(404).json({ error: 'Episode not found' });
  run('UPDATE episodes SET season=?, episode_number=?, title=?, description=?, video_url=?, duration=?, is_active=? WHERE id=?', [
    season ?? ep.season, episode_number ?? ep.episode_number, title ?? ep.title,
    description ?? ep.description, video_url ?? ep.video_url, duration ?? ep.duration,
    is_active ?? ep.is_active, req.params.id
  ]);
  res.json({ message: 'Episode updated' });
});

router.delete('/episodes/:id', (req, res) => {
  run('DELETE FROM episodes WHERE id = ?', [req.params.id]);
  res.json({ message: 'Episode deleted' });
});

// ===== SUBSCRIPTIONS =====
router.get('/subscriptions', (req, res) => {
  res.json(getAll('SELECT * FROM subscriptions ORDER BY sort_order'));
});

router.post('/subscriptions', (req, res) => {
  try {
    const { name, name_ar, price, duration_days, max_devices, quality, features, discount_percent } = req.body;
    const result = run('INSERT INTO subscriptions (name, name_ar, price, duration_days, max_devices, quality, features, discount_percent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [name, name_ar || '', price || 0, duration_days || 30, max_devices || 1, quality || 'SD',
       typeof features === 'string' ? features : JSON.stringify(features || []), discount_percent || 0]);
    res.json({ id: result.lastInsertRowid, message: 'Plan created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/subscriptions/:id', (req, res) => {
  const { name, name_ar, price, duration_days, max_devices, quality, features, discount_percent, is_active } = req.body;
  const sub = getOne('SELECT * FROM subscriptions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Not found' });
  run('UPDATE subscriptions SET name=?, name_ar=?, price=?, duration_days=?, max_devices=?, quality=?, features=?, discount_percent=?, is_active=? WHERE id=?', [
    name ?? sub.name, name_ar ?? sub.name_ar, price ?? sub.price,
    duration_days ?? sub.duration_days, max_devices ?? sub.max_devices,
    quality ?? sub.quality,
    features ? (typeof features === 'string' ? features : JSON.stringify(features)) : sub.features,
    discount_percent ?? sub.discount_percent, is_active ?? sub.is_active, req.params.id
  ]);
  res.json({ message: 'Subscription updated' });
});

router.delete('/subscriptions/:id', (req, res) => {
  run('DELETE FROM subscriptions WHERE id = ?', [req.params.id]);
  res.json({ message: 'Plan deleted' });
});

// ===== BULK IMPORT CHANNELS =====
// Accepts M3U format or simple format: name|category|url|backup_url|backup_url2
router.post('/bulk-import', (req, res) => {
  try {
    const { content, format, target } = req.body;
    // target: 'primary' (default), 'backup1', 'backup2'
    const urlTarget = target || 'primary';
    if (!content) return res.status(400).json({ error: 'No content provided' });

    let channels = [];

    if (format === 'm3u' || content.trim().startsWith('#EXTM3U')) {
      // Parse M3U format
      const lines = content.split('\n').map(l => l.trim()).filter(l => l);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXTINF:')) {
          const info = lines[i];
          const url = (lines[i + 1] && !lines[i + 1].startsWith('#')) ? lines[i + 1] : '';
          if (!url) continue;

          const nameMatch = info.match(/,(.+)$/);
          const name = nameMatch ? nameMatch[1].trim() : 'Unknown';
          const logoMatch = info.match(/tvg-logo="([^"]*)"/);
          const logo = logoMatch ? logoMatch[1] : '';
          const groupMatch = info.match(/group-title="([^"]*)"/);
          const category = groupMatch ? groupMatch[1] : 'imported';

          channels.push({ name, category, url, logo_url: logo });
          i++;
        }
      }
    } else {
      const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      lines.forEach(line => {
        const parts = line.split('|').map(p => p.trim());
        if (parts.length >= 3) {
          channels.push({ name: parts[0], category: parts[1] || 'imported', url: parts[2], logo_url: parts[3] || '' });
        } else if (parts.length === 2) {
          channels.push({ name: parts[0], category: 'imported', url: parts[1], logo_url: '' });
        }
      });
    }

    if (channels.length === 0) return res.status(400).json({ error: 'No valid channels found in content' });

    let added = 0, updated = 0, skipped = 0;
    const maxSort = (getOne('SELECT MAX(sort_order) as m FROM channels', []) || {}).m || 0;

    channels.forEach((ch, idx) => {
      try {
        const existing = getOne('SELECT * FROM channels WHERE name = ?', [ch.name]);
        if (existing) {
          // Update based on target
          if (urlTarget === 'backup1') {
            run('UPDATE channels SET backup_url=?, category=?, logo_url=? WHERE id=?', [
              ch.url,
              ch.category !== 'imported' ? ch.category : existing.category,
              ch.logo_url || existing.logo_url || '',
              existing.id
            ]);
          } else if (urlTarget === 'backup2') {
            run('UPDATE channels SET backup_url2=?, category=?, logo_url=? WHERE id=?', [
              ch.url,
              ch.category !== 'imported' ? ch.category : existing.category,
              ch.logo_url || existing.logo_url || '',
              existing.id
            ]);
          } else {
            // primary (default)
            run('UPDATE channels SET stream_url=?, category=?, logo_url=? WHERE id=?', [
              ch.url,
              ch.category !== 'imported' ? ch.category : existing.category,
              ch.logo_url || existing.logo_url || '',
              existing.id
            ]);
          }
          updated++;
        } else {
          // New channel
          const streamUrl = urlTarget === 'primary' ? ch.url : '';
          const backup1 = urlTarget === 'backup1' ? ch.url : '';
          const backup2 = urlTarget === 'backup2' ? ch.url : '';
          run('INSERT INTO channels (name, category, stream_url, backup_url, backup_url2, logo_url, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [ch.name, ch.category, streamUrl, backup1, backup2, ch.logo_url, maxSort + idx + 1]);
          added++;
        }
      } catch (e) {
        skipped++;
      }
    });

    const targetLabel = urlTarget === 'backup1' ? 'Backup 1' : urlTarget === 'backup2' ? 'Backup 2' : 'Primary';
    res.json({
      message: `✅ ${added} added, 🔄 ${updated} updated (${targetLabel}), ⏭️ ${skipped} skipped`,
      added, updated, skipped, total: channels.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== MEDIA UPLOAD =====
router.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const isVideo = req.file.mimetype.startsWith('video/');
    const fileUrl = '/media/' + (isVideo ? 'videos/' : 'images/') + req.file.filename;

    // If auto_add_movie is true and it's a video, create a movie entry
    let movieId = null;
    if (isVideo && req.body.auto_add === 'true') {
      const title = req.body.title || req.file.originalname.replace(/\.[^.]+$/, '').replace(/[_\-\.]/g, ' ');
      const category = req.body.category || 'uploaded';
      const year = req.body.year ? parseInt(req.body.year) : null;
      const description = req.body.description || '';
      const result = run('INSERT INTO movies (title, description, category, video_url, year) VALUES (?, ?, ?, ?, ?)',
        [title, description, category, fileUrl, year]);
      movieId = result.lastInsertRowid;
    }

    res.json({
      message: isVideo && movieId ? 'Video uploaded & movie added!' : 'File uploaded successfully',
      url: fileUrl,
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
      movieId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Multiple files upload
router.post('/upload-multiple', upload.array('files', 50), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
    const files = req.files.map(f => ({
      url: '/media/' + (f.mimetype.startsWith('video/') ? 'videos/' : 'images/') + f.filename,
      filename: f.filename,
      originalName: f.originalname,
      size: f.size,
      mimetype: f.mimetype
    }));
    res.json({ message: `${files.length} files uploaded`, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List uploaded media
router.get('/media', (req, res) => {
  try {
    const files = [];
    ['videos', 'images'].forEach(subDir => {
      const dir = path.join(MEDIA_DIR, subDir);
      if (fs.existsSync(dir)) {
        fs.readdirSync(dir).forEach(f => {
          const stat = fs.statSync(path.join(dir, f));
          files.push({
            url: '/media/' + subDir + '/' + f,
            filename: f,
            type: subDir === 'videos' ? 'video' : 'image',
            size: stat.size,
            created: stat.birthtime
          });
        });
      }
    });
    files.sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== LOAD BALANCING - SERVER POOL (#16) =====
router.get('/servers', (req, res) => {
  res.json(getAll('SELECT * FROM server_pool ORDER BY priority DESC'));
});

router.post('/servers', (req, res) => {
  try {
    const { name, url, region, max_connections, priority } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'Name and URL required' });
    const result = run('INSERT INTO server_pool (name, url, region, max_connections, priority) VALUES (?, ?, ?, ?, ?)',
      [name, url, region || 'default', max_connections || 100, priority || 0]);
    res.json({ id: result.lastInsertRowid, message: 'Server added' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/servers/:id', (req, res) => {
  const { name, url, region, max_connections, is_active, priority } = req.body;
  const srv = getOne('SELECT * FROM server_pool WHERE id = ?', [req.params.id]);
  if (!srv) return res.status(404).json({ error: 'Server not found' });
  run('UPDATE server_pool SET name=?, url=?, region=?, max_connections=?, is_active=?, priority=? WHERE id=?', [
    name ?? srv.name, url ?? srv.url, region ?? srv.region,
    max_connections ?? srv.max_connections, is_active ?? srv.is_active,
    priority ?? srv.priority, req.params.id
  ]);
  res.json({ message: 'Server updated' });
});

router.delete('/servers/:id', (req, res) => {
  run('DELETE FROM server_pool WHERE id = ?', [req.params.id]);
  res.json({ message: 'Server deleted' });
});

// Health check all servers
router.post('/servers/health-check', async (req, res) => {
  const servers = getAll('SELECT * FROM server_pool WHERE is_active = 1');
  const http = require('http');
  const https = require('https');
  const results = [];

  for (const srv of servers) {
    try {
      const start = Date.now();
      const url = new URL(srv.url);
      const client = url.protocol === 'https:' ? https : http;

      await new Promise((resolve, reject) => {
        const req = client.get(srv.url, { timeout: 5000 }, (response) => {
          const latency = Date.now() - start;
          const status = response.statusCode < 400 ? 'healthy' : 'degraded';
          run('UPDATE server_pool SET health_status=?, last_check=datetime("now") WHERE id=?', [status, srv.id]);
          results.push({ id: srv.id, name: srv.name, status, latency: latency + 'ms' });
          response.resume();
          resolve();
        });
        req.on('error', () => {
          run('UPDATE server_pool SET health_status="down", last_check=datetime("now") WHERE id=?', [srv.id]);
          results.push({ id: srv.id, name: srv.name, status: 'down', latency: '-' });
          resolve();
        });
        req.on('timeout', () => {
          req.destroy();
          run('UPDATE server_pool SET health_status="timeout", last_check=datetime("now") WHERE id=?', [srv.id]);
          results.push({ id: srv.id, name: srv.name, status: 'timeout', latency: '-' });
          resolve();
        });
      });
    } catch (e) {
      results.push({ id: srv.id, name: srv.name, status: 'error', latency: '-' });
    }
  }
  res.json({ checked: results.length, results });
});

// Get best server (load balancing algorithm)
router.get('/servers/best', (req, res) => {
  const servers = getAll('SELECT * FROM server_pool WHERE is_active = 1 AND (health_status = "healthy" OR health_status = "unknown") ORDER BY (CAST(current_load AS FLOAT) / max_connections) ASC, priority DESC LIMIT 1');
  if (servers.length === 0) return res.json({ server: null, message: 'No healthy servers available' });
  res.json({ server: servers[0] });
});

// ===== AUTO-IMPORT SOURCES (#17) =====
router.get('/import-sources', (req, res) => {
  res.json(getAll('SELECT * FROM import_sources ORDER BY id DESC'));
});

router.post('/import-sources', (req, res) => {
  try {
    const { name, url, type, auto_update, update_interval } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'Name and URL required' });
    const result = run('INSERT INTO import_sources (name, url, type, auto_update, update_interval) VALUES (?, ?, ?, ?, ?)',
      [name, url, type || 'm3u', auto_update ? 1 : 0, update_interval || 24]);
    res.json({ id: result.lastInsertRowid, message: 'Source added' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/import-sources/:id', (req, res) => {
  const { name, url, type, auto_update, update_interval, is_active } = req.body;
  const src = getOne('SELECT * FROM import_sources WHERE id = ?', [req.params.id]);
  if (!src) return res.status(404).json({ error: 'Source not found' });
  run('UPDATE import_sources SET name=?, url=?, type=?, auto_update=?, update_interval=?, is_active=? WHERE id=?', [
    name ?? src.name, url ?? src.url, type ?? src.type,
    auto_update !== undefined ? (auto_update ? 1 : 0) : src.auto_update,
    update_interval ?? src.update_interval, is_active ?? src.is_active, req.params.id
  ]);
  res.json({ message: 'Source updated' });
});

router.delete('/import-sources/:id', (req, res) => {
  run('DELETE FROM import_sources WHERE id = ?', [req.params.id]);
  res.json({ message: 'Source deleted' });
});

// Fetch and import from a source
router.post('/import-sources/:id/fetch', async (req, res) => {
  const src = getOne('SELECT * FROM import_sources WHERE id = ?', [req.params.id]);
  if (!src) return res.status(404).json({ error: 'Source not found' });

  try {
    const http = require('http');
    const https = require('https');

    const content = await new Promise((resolve, reject) => {
      const url = new URL(src.url);
      const client = url.protocol === 'https:' ? https : http;
      client.get(src.url, { timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
        // Follow redirects
        if ([301, 302, 307].includes(response.statusCode) && response.headers.location) {
          client.get(response.headers.location, { timeout: 30000 }, (r2) => {
            let data = '';
            r2.on('data', chunk => data += chunk);
            r2.on('end', () => resolve(data));
          }).on('error', reject);
          return;
        }
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => resolve(data));
      }).on('error', reject);
    });

    if (!content || content.length < 10) {
      return res.status(400).json({ error: 'Empty or invalid response from source' });
    }

    // Parse M3U
    const lines = content.split('\n').map(l => l.trim()).filter(l => l);
    let channels = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXTINF:')) {
        const info = lines[i];
        const url = (lines[i + 1] && !lines[i + 1].startsWith('#')) ? lines[i + 1] : '';
        if (!url) continue;

        const nameMatch = info.match(/,(.+)$/);
        const name = nameMatch ? nameMatch[1].trim() : 'Unknown';
        const logoMatch = info.match(/tvg-logo="([^"]*)"/);
        const logo = logoMatch ? logoMatch[1] : '';
        const groupMatch = info.match(/group-title="([^"]*)"/);
        const category = groupMatch ? groupMatch[1] : 'imported';

        channels.push({ name, category, url, logo_url: logo });
        i++;
      }
    }

    if (channels.length === 0) {
      return res.status(400).json({ error: 'No channels found in M3U content' });
    }

    let added = 0, updated = 0, skipped = 0;
    const maxSort = (getOne('SELECT MAX(sort_order) as m FROM channels', []) || {}).m || 0;

    channels.forEach((ch, idx) => {
      try {
        const existing = getOne('SELECT * FROM channels WHERE name = ?', [ch.name]);
        if (existing) {
          run('UPDATE channels SET stream_url=?, category=?, logo_url=? WHERE id=?', [
            ch.url,
            ch.category !== 'imported' ? ch.category : existing.category,
            ch.logo_url || existing.logo_url || '',
            existing.id
          ]);
          updated++;
        } else {
          run('INSERT INTO channels (name, category, stream_url, logo_url, sort_order) VALUES (?, ?, ?, ?, ?)',
            [ch.name, ch.category, ch.url, ch.logo_url, maxSort + idx + 1]);
          added++;
        }
      } catch (e) { skipped++; }
    });

    // Update source stats
    run('UPDATE import_sources SET last_import=datetime("now"), channels_count=? WHERE id=?', [channels.length, src.id]);

    res.json({
      message: `✅ Fetched ${channels.length} channels: ${added} added, ${updated} updated, ${skipped} skipped`,
      added, updated, skipped, total: channels.length
    });
  } catch (err) {
    res.status(500).json({ error: 'Fetch failed: ' + err.message });
  }
});

module.exports = router;
