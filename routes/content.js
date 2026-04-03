const express = require('express');
const { run, getOne, getAll } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Channels
router.get('/channels', (req, res) => {
  res.json(getAll('SELECT id, name, category, logo_url, stream_url, backup_url, backup_url2 FROM channels WHERE is_active = 1 ORDER BY sort_order'));
});

// Movies
router.get('/movies', (req, res) => {
  res.json(getAll('SELECT id, title, description, category, poster_url, video_url, duration, year, rating FROM movies WHERE is_active = 1 ORDER BY id DESC'));
});

// Series list
router.get('/series', (req, res) => {
  const series = getAll('SELECT id, title, description, category, poster_url, total_seasons, year, rating FROM series WHERE is_active = 1 ORDER BY id DESC');
  series.forEach(s => {
    s.episode_count = getOne('SELECT COUNT(*) as count FROM episodes WHERE series_id = ? AND is_active = 1', [s.id]).count;
  });
  res.json(series);
});

// Series episodes
router.get('/series/:id/episodes', (req, res) => {
  const series = getOne('SELECT * FROM series WHERE id = ? AND is_active = 1', [req.params.id]);
  if (!series) return res.status(404).json({ error: 'Series not found' });
  const episodes = getAll('SELECT * FROM episodes WHERE series_id = ? AND is_active = 1 ORDER BY season, episode_number', [req.params.id]);
  // Group by season
  const seasons = {};
  episodes.forEach(ep => {
    if (!seasons[ep.season]) seasons[ep.season] = [];
    seasons[ep.season].push(ep);
  });
  res.json({ series, seasons });
});

// Categories
router.get('/categories', (req, res) => {
  const channelCats = getAll('SELECT DISTINCT category FROM channels WHERE is_active = 1').map(r => r.category);
  const movieCats = getAll('SELECT DISTINCT category FROM movies WHERE is_active = 1').map(r => r.category);
  const seriesCats = getAll('SELECT DISTINCT category FROM series WHERE is_active = 1').map(r => r.category);
  res.json({ channels: channelCats, movies: movieCats, series: seriesCats });
});

// Watch history
router.post('/watch', (req, res) => {
  const { content_type, content_id } = req.body;
  run('INSERT INTO watch_history (user_id, content_type, content_id) VALUES (?, ?, ?)',
    [req.user.id, content_type, content_id]);
  res.json({ message: 'Logged' });
});

// Profile
router.get('/profile', (req, res) => {
  const user = getOne('SELECT id, username, role, subscription, expires_at, max_connections, created_at, last_login FROM users WHERE id = ?', [req.user.id]);
  const plan = getOne('SELECT * FROM subscriptions WHERE LOWER(name) = LOWER(?)', [user.subscription]);
  res.json({ ...user, plan });
});

module.exports = router;
