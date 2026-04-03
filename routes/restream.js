/**
 * Restream API Routes
 * POST   /add-stream       - Add new stream
 * GET    /streams           - List all streams
 * GET    /stream/:id        - Get stream details
 * PUT    /stream/:id        - Update stream
 * DELETE /stream/:id        - Remove stream
 * POST   /stream/:id/start  - Start stream
 * POST   /stream/:id/stop   - Stop stream
 * POST   /stream/:id/restart - Restart stream
 * GET    /stream/:id/logs   - Get stream logs
 * GET    /playlist.m3u      - Download M3U playlist
 * GET    /status            - System status
 */

const express = require('express');
const router = express.Router();
const restream = require('../restream');
const path = require('path');
const fs = require('fs');

// ===== ADD STREAM =====
// POST /restream/add-stream
// Body: { name, url, category?, id?, enabled? }
router.post('/add-stream', (req, res) => {
  try {
    const { name, url, category, id, enabled } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'Stream URL is required' });
    }
    if (!name) {
      return res.status(400).json({ error: 'Stream name is required' });
    }

    // Validate URL format
    try { new URL(url); } catch (e) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    const stream = restream.addStream({ name, url, category, id, enabled });

    res.json({
      success: true,
      message: `Stream "${stream.name}" added and starting`,
      stream,
      outputs: {
        hls: `/hls/${stream.id}/index.m3u8`,
        ts: `/live/${stream.id}`,
        info: `/restream/stream/${stream.id}`
      }
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ===== LIST STREAMS =====
// GET /restream/streams
router.get('/streams', (req, res) => {
  const streams = restream.getAllStreams();
  const counts = restream.getStreamCount();

  res.json({
    total: counts.total,
    running: counts.running,
    stopped: counts.stopped,
    streams: streams.map(s => ({
      id: s.id,
      name: s.name,
      url: s.url,
      category: s.category,
      enabled: s.enabled,
      isRunning: s.isRunning,
      stats: s.stats,
      outputs: {
        hls: `/hls/${s.id}/index.m3u8`,
        ts: `/live/${s.id}`
      }
    }))
  });
});

// ===== GET STREAM =====
// GET /restream/stream/:id
router.get('/stream/:id', (req, res) => {
  const stream = restream.getStream(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });

  res.json({
    ...stream,
    outputs: {
      hls: `/hls/${stream.id}/index.m3u8`,
      ts: `/live/${stream.id}`
    }
  });
});

// ===== UPDATE STREAM =====
// PUT /restream/stream/:id
router.put('/stream/:id', (req, res) => {
  try {
    const stream = restream.updateStream(req.params.id, req.body);
    res.json({ success: true, stream });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ===== DELETE STREAM =====
// DELETE /restream/stream/:id
router.delete('/stream/:id', (req, res) => {
  try {
    restream.removeStream(req.params.id);
    res.json({ success: true, message: 'Stream removed' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ===== START STREAM =====
router.post('/stream/:id/start', (req, res) => {
  try {
    const stream = restream.streams.get(req.params.id);
    if (!stream) return res.status(404).json({ error: 'Stream not found' });

    stream.enabled = true;
    restream.saveStreams();
    restream.startStream(req.params.id);
    res.json({ success: true, message: `Stream ${req.params.id} started` });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ===== STOP STREAM =====
router.post('/stream/:id/stop', (req, res) => {
  try {
    restream.stopStream(req.params.id);
    res.json({ success: true, message: `Stream ${req.params.id} stopped` });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ===== RESTART STREAM =====
router.post('/stream/:id/restart', (req, res) => {
  try {
    restream.restartStream(req.params.id);
    res.json({ success: true, message: `Stream ${req.params.id} restarting` });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ===== STREAM LOGS =====
router.get('/stream/:id/logs', (req, res) => {
  const lines = parseInt(req.query.lines) || 50;
  const logs = restream.getLogs(req.params.id, lines);
  res.json({ id: req.params.id, lines: logs.length, logs });
});

// ===== M3U PLAYLIST =====
// GET /restream/playlist.m3u
router.get('/playlist.m3u', (req, res) => {
  const baseUrl = req.protocol + '://' + req.get('host');
  const m3u = restream.generateM3U(baseUrl);

  res.setHeader('Content-Type', 'audio/mpegurl');
  res.setHeader('Content-Disposition', 'attachment; filename="restream_playlist.m3u"');
  res.send(m3u);
});

// ===== SYSTEM STATUS =====
router.get('/status', (req, res) => {
  const counts = restream.getStreamCount();
  const streams = restream.getAllStreams();

  res.json({
    server: 'IPTV Restream Server',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    streams: counts,
    details: streams.map(s => ({
      id: s.id,
      name: s.name,
      status: s.isRunning ? 'running' : (s.stats?.status || 'stopped'),
      restarts: s.stats?.restarts || 0,
      errors: s.stats?.errors || 0,
      lastError: s.stats?.lastError || null
    }))
  });
});

module.exports = router;
