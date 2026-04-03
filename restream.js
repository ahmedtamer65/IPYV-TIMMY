/**
 * IPTV Restream Manager
 * Pulls remote streams via FFmpeg and restreams as MPEG-TS + HLS
 * Auto-restart on failure, logging, M3U generation
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const HLS_DIR = path.join(BASE_DIR, 'hls');
const STREAMS_DIR = path.join(BASE_DIR, 'streams');
const LOGS_DIR = path.join(BASE_DIR, 'logs');
const STREAMS_DB = path.join(BASE_DIR, 'restreams.json');

// Ensure directories exist
[HLS_DIR, STREAMS_DIR, LOGS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

class RestreamManager extends EventEmitter {
  constructor() {
    super();
    this.streams = new Map();     // id -> stream config
    this.processes = new Map();   // id -> ffmpeg process
    this.retryTimers = new Map(); // id -> retry timer
    this.stats = new Map();       // id -> { started, restarts, errors, lastError }
    this.loadStreams();
  }

  // ===== PERSISTENCE =====
  loadStreams() {
    try {
      if (fs.existsSync(STREAMS_DB)) {
        const data = JSON.parse(fs.readFileSync(STREAMS_DB, 'utf8'));
        data.forEach(s => this.streams.set(s.id, s));
        console.log(`[Restream] Loaded ${data.length} streams from database`);
      }
    } catch (e) {
      console.error('[Restream] Failed to load streams:', e.message);
    }
  }

  saveStreams() {
    const data = Array.from(this.streams.values());
    fs.writeFileSync(STREAMS_DB, JSON.stringify(data, null, 2));
  }

  // ===== STREAM MANAGEMENT =====

  /**
   * Add a new stream
   * @param {Object} config - { name, url, category, id? }
   * url format: http://host:port/username/password/channel_id
   */
  addStream(config) {
    const id = config.id || 'stream_' + Date.now();

    if (this.streams.has(id)) {
      throw new Error(`Stream ${id} already exists`);
    }

    const stream = {
      id,
      name: config.name || `Stream ${id}`,
      url: config.url,
      category: config.category || 'general',
      enabled: config.enabled !== false,
      created_at: new Date().toISOString(),
      // Parsed info
      parsed: this.parseStreamUrl(config.url)
    };

    this.streams.set(id, stream);
    this.stats.set(id, { started: null, restarts: 0, errors: 0, lastError: null, status: 'stopped' });
    this.saveStreams();

    // Create HLS directory for this stream
    const hlsPath = path.join(HLS_DIR, id);
    if (!fs.existsSync(hlsPath)) fs.mkdirSync(hlsPath, { recursive: true });

    this.log(id, `Stream added: ${stream.name} (${stream.url})`);

    // Auto-start if enabled
    if (stream.enabled) {
      this.startStream(id);
    }

    return stream;
  }

  /**
   * Parse stream URL format: http://host:port/username/password/channel_id
   */
  parseStreamUrl(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 3) {
        return {
          host: u.origin,
          username: parts[0],
          password: parts[1],
          channelId: parts[2],
          type: parts[2].includes('.') ? 'hls' : 'ts'
        };
      }
      return { host: u.origin, type: 'direct' };
    } catch (e) {
      return { type: 'direct' };
    }
  }

  /**
   * Remove a stream
   */
  removeStream(id) {
    this.stopStream(id);
    this.streams.delete(id);
    this.stats.delete(id);
    this.saveStreams();

    // Clean up HLS files
    const hlsPath = path.join(HLS_DIR, id);
    if (fs.existsSync(hlsPath)) {
      fs.rmSync(hlsPath, { recursive: true, force: true });
    }

    this.log(id, 'Stream removed');
    return true;
  }

  /**
   * Update a stream
   */
  updateStream(id, updates) {
    const stream = this.streams.get(id);
    if (!stream) throw new Error(`Stream ${id} not found`);

    const wasRunning = this.processes.has(id);
    if (wasRunning && (updates.url || updates.enabled === false)) {
      this.stopStream(id);
    }

    Object.assign(stream, updates);
    if (updates.url) {
      stream.parsed = this.parseStreamUrl(updates.url);
    }
    this.saveStreams();

    if (updates.enabled === true && !this.processes.has(id)) {
      this.startStream(id);
    }

    return stream;
  }

  // ===== FFMPEG PROCESS MANAGEMENT =====

  /**
   * Start FFmpeg for a stream (dual output: MPEG-TS pipe + HLS files)
   */
  startStream(id) {
    const stream = this.streams.get(id);
    if (!stream) throw new Error(`Stream ${id} not found`);
    if (this.processes.has(id)) {
      this.log(id, 'Already running, skipping start');
      return;
    }

    const hlsPath = path.join(HLS_DIR, id);
    if (!fs.existsSync(hlsPath)) fs.mkdirSync(hlsPath, { recursive: true });

    const hlsOutput = path.join(hlsPath, 'index.m3u8');
    const tsOutput = path.join(STREAMS_DIR, `${id}.ts`);

    // FFmpeg arguments
    const args = [
      // Input
      '-re',                          // Read at native framerate
      '-i', stream.url,               // Input stream URL
      '-reconnect', '1',              // Auto-reconnect
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',    // Max reconnect delay 5s
      '-timeout', '10000000',         // 10s timeout (microseconds)

      // Common encoding (copy = no re-encode for speed)
      '-c:v', 'copy',
      '-c:a', 'copy',

      // Output 1: HLS
      '-f', 'hls',
      '-hls_time', '10',             // 10 second segments
      '-hls_list_size', '6',         // Keep 6 segments in playlist
      '-hls_flags', 'delete_segments+append_list+omit_endlist',
      '-hls_segment_filename', path.join(hlsPath, 'seg_%03d.ts'),
      hlsOutput,

      // Output 2: MPEG-TS file (circular buffer style)
      '-f', 'mpegts',
      '-y',                           // Overwrite
      tsOutput
    ];

    this.log(id, `Starting FFmpeg: ${stream.name}`);
    this.log(id, `Input: ${stream.url}`);
    this.log(id, `HLS Output: ${hlsOutput}`);

    const ffmpeg = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Track the process
    this.processes.set(id, ffmpeg);
    const stat = this.stats.get(id) || { restarts: 0, errors: 0 };
    stat.started = new Date().toISOString();
    stat.status = 'running';
    stat.pid = ffmpeg.pid;
    this.stats.set(id, stat);

    // Log stdout
    ffmpeg.stdout.on('data', (data) => {
      // Usually empty for FFmpeg (output goes to files)
    });

    // Log stderr (FFmpeg outputs progress here)
    let lastLog = 0;
    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      // Log errors and important messages
      if (msg.includes('Error') || msg.includes('error') || msg.includes('failed')) {
        this.log(id, `[ERROR] ${msg}`);
        stat.lastError = msg;
        stat.errors++;
      }
      // Periodic progress log (every 30s)
      const now = Date.now();
      if (now - lastLog > 30000) {
        const match = msg.match(/time=(\d+:\d+:\d+)/);
        if (match) {
          this.log(id, `[PROGRESS] Streaming at ${match[1]}`);
        }
        lastLog = now;
      }
    });

    // Handle process exit
    ffmpeg.on('close', (code, signal) => {
      this.processes.delete(id);
      stat.status = 'stopped';

      if (code !== 0 && code !== null) {
        this.log(id, `FFmpeg exited with code ${code} (signal: ${signal})`);
        stat.errors++;

        // Auto-restart if stream is still enabled
        const currentStream = this.streams.get(id);
        if (currentStream && currentStream.enabled) {
          stat.restarts++;
          this.log(id, `Auto-restarting in 3 seconds... (restart #${stat.restarts})`);
          stat.status = 'restarting';

          const timer = setTimeout(() => {
            this.retryTimers.delete(id);
            if (this.streams.has(id) && this.streams.get(id).enabled) {
              this.startStream(id);
            }
          }, 3000);
          this.retryTimers.set(id, timer);
        }
      } else {
        this.log(id, 'FFmpeg stopped cleanly');
      }
    });

    ffmpeg.on('error', (err) => {
      this.processes.delete(id);
      stat.status = 'error';
      stat.lastError = err.message;
      stat.errors++;
      this.log(id, `FFmpeg spawn error: ${err.message}`);

      // Retry
      const currentStream = this.streams.get(id);
      if (currentStream && currentStream.enabled) {
        stat.restarts++;
        const timer = setTimeout(() => {
          this.retryTimers.delete(id);
          this.startStream(id);
        }, 3000);
        this.retryTimers.set(id, timer);
      }
    });

    this.emit('stream-started', { id, name: stream.name });
    return ffmpeg.pid;
  }

  /**
   * Stop a stream
   */
  stopStream(id) {
    // Clear retry timer
    if (this.retryTimers.has(id)) {
      clearTimeout(this.retryTimers.get(id));
      this.retryTimers.delete(id);
    }

    const proc = this.processes.get(id);
    if (proc) {
      this.log(id, 'Stopping FFmpeg...');
      proc.kill('SIGTERM');

      // Force kill after 5 seconds
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch(e) {}
      }, 5000);

      this.processes.delete(id);
    }

    const stat = this.stats.get(id);
    if (stat) stat.status = 'stopped';

    // Temporarily disable to prevent auto-restart
    const stream = this.streams.get(id);
    if (stream) {
      stream.enabled = false;
      this.saveStreams();
    }
  }

  /**
   * Restart a stream
   */
  restartStream(id) {
    const stream = this.streams.get(id);
    if (!stream) throw new Error(`Stream ${id} not found`);

    this.stopStream(id);
    stream.enabled = true;
    this.saveStreams();

    setTimeout(() => this.startStream(id), 1000);
  }

  // ===== GETTERS =====

  getStream(id) {
    const stream = this.streams.get(id);
    if (!stream) return null;
    return { ...stream, stats: this.stats.get(id) || {} };
  }

  getAllStreams() {
    return Array.from(this.streams.values()).map(s => ({
      ...s,
      stats: this.stats.get(s.id) || {},
      isRunning: this.processes.has(s.id)
    }));
  }

  getStreamCount() {
    return {
      total: this.streams.size,
      running: this.processes.size,
      stopped: this.streams.size - this.processes.size
    };
  }

  // ===== HLS & TS ACCESS =====

  getHlsPath(id) {
    return path.join(HLS_DIR, id, 'index.m3u8');
  }

  getTsPath(id) {
    return path.join(STREAMS_DIR, `${id}.ts`);
  }

  /**
   * Generate M3U playlist from all active restreams
   */
  generateM3U(baseUrl) {
    let m3u = '#EXTM3U\n';
    m3u += '#EXTINF:-1 tvg-name="Info" group-title="System",Restream Server\n';
    m3u += `${baseUrl}/restream/status\n`;

    for (const [id, stream] of this.streams) {
      if (!stream.enabled) continue;

      // HLS version
      m3u += `#EXTINF:-1 tvg-id="${id}" tvg-name="${stream.name}" group-title="${stream.category}",${stream.name} (HLS)\n`;
      m3u += `${baseUrl}/hls/${id}/index.m3u8\n`;

      // Direct TS version
      m3u += `#EXTINF:-1 tvg-id="${id}_ts" tvg-name="${stream.name} TS" group-title="${stream.category}",${stream.name} (TS)\n`;
      m3u += `${baseUrl}/live/${id}\n`;
    }

    return m3u;
  }

  // ===== LOGGING =====

  log(id, message) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${id}] ${message}\n`;

    console.log(`[Restream] ${logLine.trim()}`);

    // Write to log file
    const logFile = path.join(LOGS_DIR, `${id}.log`);
    try {
      fs.appendFileSync(logFile, logLine);

      // Rotate log if > 5MB
      const stat = fs.statSync(logFile);
      if (stat.size > 5 * 1024 * 1024) {
        const archivePath = path.join(LOGS_DIR, `${id}.old.log`);
        if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
        fs.renameSync(logFile, archivePath);
      }
    } catch (e) {}
  }

  getLogs(id, lines = 50) {
    const logFile = path.join(LOGS_DIR, `${id}.log`);
    if (!fs.existsSync(logFile)) return [];

    const content = fs.readFileSync(logFile, 'utf8');
    return content.split('\n').filter(Boolean).slice(-lines);
  }

  // ===== CLEANUP =====

  stopAll() {
    console.log('[Restream] Stopping all streams...');
    for (const id of this.processes.keys()) {
      this.stopStream(id);
    }
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
  }

  /**
   * Start all enabled streams (call on server startup)
   */
  startAllEnabled() {
    let count = 0;
    for (const [id, stream] of this.streams) {
      if (stream.enabled && !this.processes.has(id)) {
        setTimeout(() => this.startStream(id), count * 2000); // Stagger starts
        count++;
      }
    }
    if (count > 0) {
      console.log(`[Restream] Starting ${count} enabled streams...`);
    }
  }
}

// Singleton
const manager = new RestreamManager();

// Graceful shutdown
process.on('SIGTERM', () => manager.stopAll());
process.on('SIGINT', () => manager.stopAll());

module.exports = manager;
