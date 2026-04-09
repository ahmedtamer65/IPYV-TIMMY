const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const DB_PATH = path.join(BASE_DIR, 'iptv.db');
const DB_BACKUP = path.join(BASE_DIR, 'iptv.db.backup');

let db = null;
let _saveTimer = null;
let _savePending = false;
let _dbReady = false; // Only allow saves after init completes successfully

function saveDb() {
  try {
    if (!db) return;
    const data = db.export();
    const buf = Buffer.from(data);

    // Safety check: never save an empty/tiny database over a bigger one
    if (fs.existsSync(DB_PATH)) {
      const existingSize = fs.statSync(DB_PATH).size;
      if (existingSize > 5000 && buf.length < existingSize * 0.5) {
        console.error(`🛑 SAVE BLOCKED: New DB (${buf.length} bytes) is <50% of existing (${existingSize} bytes). Possible data loss!`);
        return;
      }
    }

    // Write to temp file first, then rename (atomic write - prevents corruption)
    const tmpPath = DB_PATH + '.tmp';
    fs.writeFileSync(tmpPath, buf);
    // Keep a backup copy before overwriting
    if (fs.existsSync(DB_PATH)) {
      try { fs.copyFileSync(DB_PATH, DB_BACKUP); } catch(e) {}
    }
    fs.renameSync(tmpPath, DB_PATH);
    _savePending = false;
  } catch(e) {
    console.error('DB save error:', e.message);
    // Fallback: direct write
    try {
      const data = db.export();
      const buf = Buffer.from(data);
      // Same safety check in fallback
      if (fs.existsSync(DB_PATH)) {
        const existingSize = fs.statSync(DB_PATH).size;
        if (existingSize > 5000 && buf.length < existingSize * 0.5) {
          console.error('🛑 SAVE BLOCKED (fallback): Data too small, refusing to overwrite');
          return;
        }
      }
      fs.writeFileSync(DB_PATH, buf);
      _savePending = false;
    } catch(e2) { console.error('DB save fallback failed:', e2.message); }
  }
}

// Debounced save — groups rapid writes, saves once after 1 second of no writes
function scheduleSave() {
  _savePending = true;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { saveDb(); _saveTimer = null; }, 1000);
}

// Auto-save every 10 seconds as safety net (only if there are pending changes)
setInterval(() => { if (db && _savePending) saveDb(); }, 10000);

// Save on process exit to prevent data loss
function emergencySave() { if (db && _savePending) { try { saveDb(); } catch(e) {} } }
process.on('exit', emergencySave);
process.on('SIGINT', () => { console.log('\n💾 Saving database before exit...'); emergencySave(); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n💾 Saving database before exit...'); emergencySave(); process.exit(0); });
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); emergencySave(); });
process.on('unhandledRejection', (err) => { console.error('Unhandled rejection:', err); emergencySave(); });

async function init() {
  const SQL = await initSqlJs();

  // Lock file — prevent two servers from writing to same DB
  const LOCK_FILE = path.join(BASE_DIR, 'iptv.lock');
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      const lockAge = Date.now() - lockData.time;
      if (lockAge < 10000) { // Lock less than 10 seconds old = another server is running
        console.error('⚠️  WARNING: Another server may be running! (Lock file is ' + (lockAge/1000).toFixed(1) + 's old)');
        console.error('   This can cause data loss! Kill other node processes first.');
        console.error('   If no other server is running, delete: ' + LOCK_FILE);
      }
    } catch(e) {}
  }
  // Write our lock
  const updateLock = () => {
    try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, time: Date.now() })); } catch(e) {}
  };
  updateLock();
  setInterval(updateLock, 5000);
  process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE); } catch(e) {} });

  // ===== DATABASE LOADING WITH FULL PROTECTION =====

  // Check for .tmp file from interrupted save — recover it
  const tmpPath = DB_PATH + '.tmp';
  if (fs.existsSync(tmpPath)) {
    const tmpSize = fs.statSync(tmpPath).size;
    console.log(`⚠️  Found interrupted save file (${(tmpSize/1024).toFixed(1)} KB)`);
    if (tmpSize > 100) {
      // If main DB is missing or smaller, use the tmp file
      const mainSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
      if (tmpSize >= mainSize) {
        try {
          const tmpBuf = fs.readFileSync(tmpPath);
          const testDb = new SQL.Database(tmpBuf);
          testDb.exec('SELECT COUNT(*) FROM users'); // Sanity check
          testDb.close();
          // It's valid — use it
          if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, DB_BACKUP);
          fs.renameSync(tmpPath, DB_PATH);
          console.log('✅ Recovered database from interrupted save');
        } catch(e) {
          console.log('   tmp file is corrupted, ignoring');
          try { fs.unlinkSync(tmpPath); } catch(e2) {}
        }
      } else {
        try { fs.unlinkSync(tmpPath); } catch(e) {}
      }
    } else {
      try { fs.unlinkSync(tmpPath); } catch(e) {}
    }
  }

  // Load the database — try main file, then backup, then create new
  let loadedFrom = 'new';
  if (fs.existsSync(DB_PATH)) {
    try {
      const buffer = fs.readFileSync(DB_PATH);
      if (buffer.length < 100) throw new Error('DB file too small (' + buffer.length + ' bytes), likely corrupted');
      db = new SQL.Database(buffer);
      // Sanity check: can we read tables?
      const tableCheck = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
      const tables = tableCheck.length > 0 ? tableCheck[0].values.map(v => v[0]) : [];
      if (tables.length < 3) throw new Error('DB has only ' + tables.length + ' tables, likely incomplete');
      db.exec('SELECT COUNT(*) FROM users');
      loadedFrom = 'main';
      console.log(`✅ Database loaded from ${DB_PATH} (${(buffer.length/1024).toFixed(1)} KB, ${tables.length} tables)`);
    } catch(e) {
      console.error('❌ Main database error:', e.message);
      db = null;
      // Try backup
      if (fs.existsSync(DB_BACKUP)) {
        console.log('   Trying backup...');
        try {
          const backupBuf = fs.readFileSync(DB_BACKUP);
          if (backupBuf.length < 100) throw new Error('Backup too small');
          db = new SQL.Database(backupBuf);
          db.exec('SELECT COUNT(*) FROM users');
          loadedFrom = 'backup';
          console.log('✅ Restored from backup! (' + (backupBuf.length/1024).toFixed(1) + ' KB)');
          // Save the restored backup as main
          saveDb();
        } catch(e2) {
          console.error('   ❌ Backup also failed:', e2.message);
          db = null;
        }
      }
      if (!db) {
        console.log('   Creating fresh database...');
        db = new SQL.Database();
        loadedFrom = 'new';
      }
    }
  } else {
    db = new SQL.Database();
    console.log('📦 Creating new database (no existing file found)');
    loadedFrom = 'new';
  }

  // Log what we loaded — this helps debug data loss
  console.log(`   DB source: ${loadedFrom} | PID: ${process.pid}`);

  // Users
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    subscription TEXT DEFAULT 'trial',
    expires_at TEXT,
    max_connections INTEGER DEFAULT 1,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT,
    notes TEXT
  )`);

  // Channels
  db.run(`CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    logo_url TEXT,
    stream_url TEXT,
    backup_url TEXT,
    backup_url2 TEXT,
    epg_id TEXT,
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  try { db.run('ALTER TABLE channels ADD COLUMN watermark INTEGER DEFAULT 1'); } catch(e) {}
  try { db.run('ALTER TABLE channels ADD COLUMN watermark_url TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE channels ADD COLUMN watermark_position TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE channels ADD COLUMN watermark_opacity REAL'); } catch(e) {}
  try { db.run('ALTER TABLE channels ADD COLUMN watermark_size INTEGER'); } catch(e) {}

  // Movies
  db.run(`CREATE TABLE IF NOT EXISTS movies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'general',
    poster_url TEXT,
    video_url TEXT,
    backup_url TEXT,
    backup_url2 TEXT,
    duration INTEGER,
    year INTEGER,
    rating REAL,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    cast_list TEXT,
    director TEXT,
    genre TEXT,
    backdrop_url TEXT,
    tmdb_id INTEGER
  )`);
  // Migration: add new columns if they don't exist
  try { db.run('ALTER TABLE movies ADD COLUMN cast_list TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE movies ADD COLUMN director TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE movies ADD COLUMN genre TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE movies ADD COLUMN backdrop_url TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE movies ADD COLUMN tmdb_id INTEGER'); } catch(e) {}
  try { db.run('ALTER TABLE movies ADD COLUMN watermark INTEGER DEFAULT 1'); } catch(e) {}
  try { db.run('ALTER TABLE movies ADD COLUMN watermark_url TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE movies ADD COLUMN watermark_position TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE movies ADD COLUMN watermark_opacity REAL'); } catch(e) {}
  try { db.run('ALTER TABLE movies ADD COLUMN watermark_size INTEGER'); } catch(e) {}

  // Series
  db.run(`CREATE TABLE IF NOT EXISTS series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'drama',
    poster_url TEXT,
    total_seasons INTEGER DEFAULT 1,
    year INTEGER,
    rating REAL,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    cast_list TEXT,
    director TEXT,
    genre TEXT,
    backdrop_url TEXT,
    tmdb_id INTEGER
  )`);
  try { db.run('ALTER TABLE series ADD COLUMN cast_list TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE series ADD COLUMN director TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE series ADD COLUMN genre TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE series ADD COLUMN backdrop_url TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE series ADD COLUMN tmdb_id INTEGER'); } catch(e) {}
  try { db.run('ALTER TABLE series ADD COLUMN watermark INTEGER DEFAULT 1'); } catch(e) {}
  try { db.run('ALTER TABLE series ADD COLUMN watermark_url TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE series ADD COLUMN watermark_position TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE series ADD COLUMN watermark_opacity REAL'); } catch(e) {}
  try { db.run('ALTER TABLE series ADD COLUMN watermark_size INTEGER'); } catch(e) {}

  // Episodes
  db.run(`CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL,
    season INTEGER DEFAULT 1,
    episode_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    video_url TEXT,
    backup_url TEXT,
    backup_url2 TEXT,
    duration INTEGER,
    is_active INTEGER DEFAULT 1,
    FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
  )`);

  // Watch History
  db.run(`CREATE TABLE IF NOT EXISTS watch_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    content_type TEXT,
    content_id INTEGER,
    watched_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // Audit Log (Anti-Piracy)
  db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    details TEXT,
    ip_address TEXT,
    user_agent TEXT,
    risk_level TEXT DEFAULT 'low',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // Suspicious Activity Flags
  db.run(`CREATE TABLE IF NOT EXISTS suspicious_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type TEXT NOT NULL,
    description TEXT,
    ip_addresses TEXT,
    detected_at TEXT DEFAULT (datetime('now')),
    resolved INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // Load Balancing - Server Pool
  db.run(`CREATE TABLE IF NOT EXISTS server_pool (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    region TEXT DEFAULT 'default',
    max_connections INTEGER DEFAULT 100,
    current_load INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    priority INTEGER DEFAULT 0,
    health_status TEXT DEFAULT 'unknown',
    last_check TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // Auto-Import Sources
  db.run(`CREATE TABLE IF NOT EXISTS import_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    type TEXT DEFAULT 'm3u',
    auto_update INTEGER DEFAULT 0,
    update_interval INTEGER DEFAULT 24,
    last_import TEXT,
    channels_count INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // Subscription Plans
  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_ar TEXT,
    price REAL,
    duration_days INTEGER,
    max_devices INTEGER DEFAULT 1,
    quality TEXT DEFAULT 'SD',
    features TEXT,
    is_active INTEGER DEFAULT 1,
    discount_percent INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0
  )`);

  // Site Settings
  db.run(`CREATE TABLE IF NOT EXISTS site_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    value TEXT DEFAULT ''
  )`);

  // Custom 24/7 Channels
  db.run(`CREATE TABLE IF NOT EXISTS custom_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    logo_url TEXT,
    video_urls TEXT DEFAULT '[]',
    watermark INTEGER DEFAULT 1,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  try { db.run('ALTER TABLE custom_channels ADD COLUMN watermark INTEGER DEFAULT 1'); } catch(e) {}
  try { db.run("ALTER TABLE custom_channels ADD COLUMN category TEXT DEFAULT '24/7 Channels'"); } catch(e) {}
  try { db.run("ALTER TABLE custom_channels ADD COLUMN durations TEXT DEFAULT '[]'"); } catch(e) {}
  try { db.run('ALTER TABLE custom_channels ADD COLUMN watermark_url TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE custom_channels ADD COLUMN watermark_position TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE custom_channels ADD COLUMN watermark_opacity REAL'); } catch(e) {}
  try { db.run('ALTER TABLE custom_channels ADD COLUMN watermark_size INTEGER'); } catch(e) {}
  try { db.run("ALTER TABLE custom_channels ADD COLUMN stream_format TEXT DEFAULT 'm3u8'"); } catch(e) {}
  try { db.run('ALTER TABLE custom_channels ADD COLUMN show_in_live INTEGER DEFAULT 1'); } catch(e) {}

  // View Statistics (Analytics)
  db.run(`CREATE TABLE IF NOT EXISTS view_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    channel_id INTEGER,
    channel_name TEXT,
    stream_type TEXT DEFAULT 'live',
    started_at TEXT DEFAULT (datetime('now')),
    ended_at TEXT,
    duration_seconds INTEGER DEFAULT 0,
    ip_address TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
  // Indexes for fast analytics queries
  try { db.run('CREATE INDEX IF NOT EXISTS idx_view_stats_started ON view_stats(started_at)'); } catch(e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_view_stats_user ON view_stats(user_id)'); } catch(e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_view_stats_type ON view_stats(stream_type)'); } catch(e) {}

  // EPG (Electronic Program Guide)
  db.run(`CREATE TABLE IF NOT EXISTS epg_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_epg_channel ON epg_data(channel_id)'); } catch(e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_epg_time ON epg_data(start_time, end_time)'); } catch(e) {}

  // Catch-up Recordings
  db.run(`CREATE TABLE IF NOT EXISTS catchup_recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER,
    title TEXT,
    start_time TEXT,
    end_time TEXT,
    video_url TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  try { db.run('ALTER TABLE channels ADD COLUMN catchup_enabled INTEGER DEFAULT 0'); } catch(e) {}

  // Favorites
  db.run(`CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    item_type TEXT,
    item_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, item_type, item_id)
  )`);

  // Ratings
  db.run(`CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    item_type TEXT,
    item_id INTEGER,
    rating INTEGER,
    comment TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, item_type, item_id)
  )`);

  // Blocked Countries / GeoBlock
  db.run(`CREATE TABLE IF NOT EXISTS geo_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    action TEXT DEFAULT 'block',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // === SEED DATA ===

  // Admin
  const admin = getOne('SELECT id FROM users WHERE username = ?', ['admin']);
  if (!admin) {
    const hash = bcrypt.hashSync('admin123', 10);
    run('INSERT INTO users (username, password, role, subscription, max_connections) VALUES (?, ?, ?, ?, ?)',
      ['admin', hash, 'admin', 'yearly', 10]);
    console.log('Default admin: admin / admin123');
  }

  // Subscriptions
  const planCount = getOne('SELECT COUNT(*) as count FROM subscriptions', []);
  if (planCount.count === 0) {
    const plans = [
      ['Free Trial', 'تجربة مجانية', 0, 3, 1, 'SD',
        JSON.stringify(['SD Quality', '10 Channels Only', '1 Device', 'No Movies']), 0, 0],
      ['Monthly', 'شهري', 9.99, 30, 2, 'HD',
        JSON.stringify(['HD Quality', 'All Channels', 'All Movies & Series', '2 Devices']), 0, 1],
      ['6 Months', '6 شهور', 49.99, 180, 3, 'FHD',
        JSON.stringify(['FHD Quality', 'All Channels', 'All Movies & Series', '3 Devices', 'Save 17%']), 17, 2],
      ['Yearly', 'سنوي', 79.99, 365, 4, '4K',
        JSON.stringify(['4K Quality', 'All Content', '4 Devices', 'Priority Support', 'Save 33%']), 33, 3],
      ['2 Accounts Yearly', 'حسابين سنوي', 119.99, 365, 4, '4K',
        JSON.stringify(['4K Quality', '2 Accounts', '4 Devices Each', 'All Content', 'Save 50%', 'Best Deal!']), 50, 4],
    ];
    plans.forEach(p => {
      run('INSERT INTO subscriptions (name, name_ar, price, duration_days, max_devices, quality, features, discount_percent, sort_order) VALUES (?,?,?,?,?,?,?,?,?)', p);
    });
    console.log('Subscription plans created');
  }

  // Site Settings — seed defaults if empty
  const settingsCount = getOne('SELECT COUNT(*) as count FROM site_settings', []);
  if (settingsCount.count === 0) {
    const defaults = [
      ['site_name', 'IPTV Pro'],
      ['logo_url', ''],
      ['watermark_url', ''],
      ['watermark_position', 'top-right'],
      ['watermark_opacity', '0.5'],
    ];
    defaults.forEach(([key, value]) => {
      run('INSERT INTO site_settings (key, value) VALUES (?, ?)', [key, value]);
    });
    console.log('Site settings seeded');
  }

  // Channels
  const chCount = getOne('SELECT COUNT(*) as count FROM channels', []);
  if (chCount.count === 0) {
    // Public test/demo HLS streams for learning
    const testHLS = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'; // Big Buck Bunny HLS
    const testHLS2 = 'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8'; // Akamai test
    const testHLS3 = 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8'; // Tears of Steel

    const channels = [
      // ===== beIN Sports ===== (using test streams for demo)
      ['beIN Sports 1 HD', 'bein-sports', 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/34/BeIN_Sports_logo_%282017%29.svg/200px-BeIN_Sports_logo_%282017%29.svg.png', 'http://classe.iptv.newtvhd.com:8080/1901271330/5y29HpRSE60e8GD/220364', testHLS, testHLS2, 1],
      ['beIN Sports 2 HD', 'bein-sports', '', testHLS2, testHLS, testHLS3, 2],
      ['beIN Sports 3 HD', 'bein-sports', '', testHLS, testHLS2, '', 3],
      ['beIN Sports 4 HD', 'bein-sports', '', testHLS2, testHLS, '', 4],
      ['beIN Sports 5 HD', 'bein-sports', '', testHLS, testHLS3, '', 5],
      ['beIN Sports 6 HD', 'bein-sports', '', testHLS2, testHLS, '', 6],
      ['beIN Sports 7 HD', 'bein-sports', '', testHLS, testHLS2, '', 7],
      ['beIN Sports 8 HD', 'bein-sports', '', testHLS3, testHLS, '', 8],
      ['beIN Sports 9 HD', 'bein-sports', '', testHLS, testHLS2, '', 9],
      ['beIN Sports 10 HD', 'bein-sports', '', testHLS2, testHLS, '', 10],
      ['beIN Sports 11 HD', 'bein-sports', '', testHLS, testHLS3, '', 11],
      ['beIN Sports 12 HD', 'bein-sports', '', testHLS2, testHLS, '', 12],
      ['beIN Sports 13 HD', 'bein-sports', '', testHLS, testHLS2, '', 13],
      ['beIN Sports Premium 1 HD', 'bein-premium', '', testHLS3, testHLS, testHLS2, 14],
      ['beIN Sports Premium 2 HD', 'bein-premium', '', testHLS, testHLS2, testHLS3, 15],
      ['beIN Sports Premium 3 HD', 'bein-premium', '', testHLS2, testHLS3, testHLS, 16],
      ['beIN 4K', 'bein-premium', '', testHLS, testHLS2, '', 17],
      ['beIN Sports News', 'bein-sports', '', testHLS2, testHLS, '', 18],
      ['beIN Sports Xtra', 'bein-sports', '', testHLS, testHLS3, '', 19],
      // ===== beIN Entertainment =====
      ['beIN Movies 1 HD', 'bein-movies', '', testHLS3, testHLS, '', 20],
      ['beIN Movies 2 HD', 'bein-movies', '', testHLS, testHLS2, '', 21],
      ['beIN Movies 3 HD', 'bein-movies', '', testHLS2, testHLS, '', 22],
      ['beIN Movies 4 HD', 'bein-movies', '', testHLS, testHLS3, '', 23],
      ['beIN Drama 1 HD', 'bein-entertainment', '', testHLS2, testHLS, '', 24],
      ['beIN Drama 2 HD', 'bein-entertainment', '', testHLS, testHLS2, '', 25],
      ['beIN Series HD', 'bein-entertainment', '', testHLS3, testHLS, '', 26],
      ['beIN Entertainment 1 HD', 'bein-entertainment', '', testHLS, testHLS2, '', 27],
      ['beIN Entertainment 2 HD', 'bein-entertainment', '', testHLS2, testHLS, '', 28],
      ['beIN Gourmet HD', 'bein-entertainment', '', testHLS, testHLS3, '', 29],
      ['beIN Kids HD', 'bein-entertainment', '', testHLS2, testHLS, '', 30],
      // ===== News ===== (Real public live streams!)
      ['Al Jazeera Arabic', 'news', 'https://upload.wikimedia.org/wikipedia/en/thumb/f/f2/Aljazeera.svg/200px-Aljazeera.svg.png', 'https://live-hls-web-aja.getaj.net/AJA/index.m3u8', testHLS, '', 31],
      ['Al Jazeera English', 'news', 'https://upload.wikimedia.org/wikipedia/en/thumb/f/f2/Aljazeera.svg/200px-Aljazeera.svg.png', 'https://live-hls-web-aje.getaj.net/AJE/index.m3u8', testHLS2, '', 32],
      ['Al Arabiya', 'news', '', 'https://live.alarabiya.net/alarabiapublish/alarabiya.smil/playlist.m3u8', testHLS, '', 33],
      ['Sky News Arabia', 'news', '', 'https://stream.skynewsarabia.com/hls/sna.m3u8', testHLS, '', 34],
      ['Al Hadath', 'news', '', 'https://live.alarabiya.net/alarabiapublish/alhadath.smil/playlist.m3u8', testHLS, '', 35],
      ['BBC Arabic', 'news', '', 'https://vs-hls-push-uk-live.akamaized.net/x=4/i=urn:bbc:pips:service:bbc_arabic_tv/pc_hd_abr_v2.m3u8', testHLS2, '', 36],
      ['France 24 Arabic', 'news', '', 'https://stream.france24.com/f24_ar/smil:f24_ar.smil/playlist.m3u8', testHLS, '', 37],
      ['France 24 English', 'news', '', 'https://stream.france24.com/f24_en/smil:f24_en.smil/playlist.m3u8', testHLS2, '', 38],
      ['DW Arabic', 'news', '', 'https://dwamdstream104.akamaized.net/hls/live/2015530/dwstream104/index.m3u8', testHLS, '', 39],
      ['DW English', 'news', '', 'https://dwamdstream102.akamaized.net/hls/live/2015525/dwstream102/index.m3u8', testHLS2, '', 40],
      ['TRT Arabic', 'news', '', 'https://tv-trtarapca.medya.trt.com.tr/master.m3u8', testHLS, '', 41],
      ['TRT World', 'news', '', 'https://tv-trtworld.medya.trt.com.tr/master.m3u8', testHLS2, '', 42],
      ['RT Arabic', 'news', '', testHLS, testHLS2, '', 43],
      ['Euro News', 'news', '', testHLS2, testHLS, '', 44],
      ['CGTN Arabic', 'news', '', 'https://news.cgtn.com/resource/live/arabic/cgtn-arabic.m3u8', testHLS, '', 45],
      // ===== Sports =====
      ['SSC 1 HD', 'sports', '', testHLS, testHLS2, testHLS3, 46],
      ['SSC 2 HD', 'sports', '', testHLS2, testHLS, '', 47],
      ['SSC 3 HD', 'sports', '', testHLS, testHLS3, '', 48],
      ['SSC 4 HD', 'sports', '', testHLS3, testHLS, '', 49],
      ['SSC 5 HD', 'sports', '', testHLS, testHLS2, '', 50],
      ['Abu Dhabi Sports 1 HD', 'sports', '', testHLS2, testHLS, '', 51],
      ['Abu Dhabi Sports 2 HD', 'sports', '', testHLS, testHLS2, '', 52],
      ['Dubai Sports HD', 'sports', '', testHLS3, testHLS, '', 53],
      ['KSA Sports 1 HD', 'sports', '', testHLS, testHLS2, '', 54],
      ['KSA Sports 2 HD', 'sports', '', testHLS2, testHLS, '', 55],
      ['Nile Sport', 'sports', '', testHLS, testHLS3, '', 56],
      // ===== Entertainment =====
      ['MBC 1', 'entertainment', '', testHLS, testHLS2, '', 57],
      ['MBC 2', 'entertainment', '', testHLS2, testHLS, '', 58],
      ['MBC 3', 'entertainment', '', testHLS, testHLS3, '', 59],
      ['MBC 4', 'entertainment', '', testHLS3, testHLS, '', 60],
      ['MBC Drama', 'entertainment', '', testHLS, testHLS2, '', 61],
      ['MBC Action', 'entertainment', '', testHLS2, testHLS, '', 62],
      ['MBC Masr', 'entertainment', '', testHLS, testHLS2, '', 63],
      ['MBC Masr 2', 'entertainment', '', testHLS2, testHLS, '', 64],
      ['MBC Max', 'entertainment', '', testHLS3, testHLS, '', 65],
      ['MBC Persia', 'entertainment', '', testHLS, testHLS2, '', 66],
      ['MBC Bollywood', 'entertainment', '', testHLS2, testHLS, '', 67],
      // ===== Rotana =====
      ['Rotana Cinema', 'movies-channels', '', testHLS, testHLS2, '', 68],
      ['Rotana Classic', 'movies-channels', '', testHLS2, testHLS, '', 69],
      ['Rotana Khalijia', 'entertainment', '', testHLS, testHLS3, '', 70],
      ['Rotana Drama', 'entertainment', '', testHLS3, testHLS, '', 71],
      ['Rotana Music', 'music', '', testHLS, testHLS2, '', 72],
      ['Rotana Clip', 'music', '', testHLS2, testHLS, '', 73],
      // ===== Egyptian =====
      ['CBC', 'entertainment', '', testHLS, testHLS2, '', 74],
      ['CBC Drama', 'entertainment', '', testHLS2, testHLS, '', 75],
      ['CBC Sofra', 'entertainment', '', testHLS, testHLS3, '', 76],
      ['ON E', 'entertainment', '', testHLS3, testHLS, '', 77],
      ['ON Drama', 'entertainment', '', testHLS, testHLS2, '', 78],
      ['ON Sport', 'sports', '', testHLS2, testHLS, '', 79],
      ['DMC', 'entertainment', '', testHLS, testHLS2, '', 80],
      ['DMC Drama', 'entertainment', '', testHLS2, testHLS, '', 81],
      ['Al Nahar', 'entertainment', '', testHLS, testHLS3, '', 82],
      ['Al Nahar Drama', 'entertainment', '', testHLS3, testHLS, '', 83],
      ['Al Hayat', 'entertainment', '', testHLS, testHLS2, '', 84],
      ['Al Hayat 2', 'entertainment', '', testHLS2, testHLS, '', 85],
      // ===== Gulf & Other Arab =====
      ['Abu Dhabi TV', 'entertainment', '', testHLS, testHLS2, '', 86],
      ['Dubai TV', 'entertainment', '', testHLS2, testHLS, '', 87],
      ['Sharjah TV', 'entertainment', '', testHLS, testHLS3, '', 88],
      ['Kuwait TV', 'entertainment', '', testHLS3, testHLS, '', 89],
      ['Qatar TV', 'entertainment', '', testHLS, testHLS2, '', 90],
      ['Bahrain TV', 'entertainment', '', testHLS2, testHLS, '', 91],
      ['Oman TV', 'entertainment', '', testHLS, testHLS2, '', 92],
      ['Saudi TV 1', 'entertainment', '', testHLS2, testHLS, '', 93],
      // ===== Movies Channels =====
      ['Star Movies', 'movies-channels', '', testHLS, testHLS2, '', 94],
      ['Fox Movies', 'movies-channels', '', testHLS2, testHLS, '', 95],
      ['Paramount Movies', 'movies-channels', '', testHLS3, testHLS, '', 96],
      ['ART Cinema', 'movies-channels', '', testHLS, testHLS3, '', 97],
      ['Zee Aflam', 'movies-channels', '', testHLS, testHLS2, '', 98],
      ['ART Aflam 1', 'movies-channels', '', testHLS2, testHLS, '', 99],
      ['ART Aflam 2', 'movies-channels', '', testHLS, testHLS2, '', 100],
      // ===== Kids =====
      ['Spacetoon', 'kids', '', testHLS, testHLS2, '', 101],
      ['Cartoon Network Arabic', 'kids', '', testHLS2, testHLS, '', 102],
      ['Nickelodeon Arabic', 'kids', '', testHLS, testHLS3, '', 103],
      ['Disney Channel Arabic', 'kids', '', testHLS3, testHLS, '', 104],
      ['Baraem', 'kids', '', testHLS, testHLS2, '', 105],
      ['Karameesh', 'kids', '', testHLS2, testHLS, '', 106],
      ['Toyor Al Jannah', 'kids', '', testHLS, testHLS2, '', 107],
      ['Toyor Baby', 'kids', '', testHLS2, testHLS, '', 108],
      ['Majid TV', 'kids', '', testHLS, testHLS3, '', 109],
      ['MBC 3 HD', 'kids', '', testHLS3, testHLS, '', 110],
      ['CN Arabia', 'kids', '', testHLS, testHLS2, '', 111],
      // ===== Music =====
      ['Mazzika', 'music', '', testHLS, testHLS2, '', 112],
      ['Melody', 'music', '', testHLS2, testHLS, '', 113],
      ['MTV Arabia', 'music', '', testHLS, testHLS3, '', 114],
      ['Mix Hollywood', 'music', '', testHLS3, testHLS, '', 115],
      ['Nogoum FM TV', 'music', '', testHLS, testHLS2, '', 116],
      ['Mazzika Zoom', 'music', '', testHLS2, testHLS, '', 117],
      // ===== Documentary =====
      ['National Geographic Abu Dhabi', 'documentary', '', testHLS, testHLS2, '', 118],
      ['Discovery Channel', 'documentary', '', testHLS2, testHLS, '', 119],
      ['Animal Planet', 'documentary', '', testHLS3, testHLS, '', 120],
      ['History Channel', 'documentary', '', testHLS, testHLS3, '', 121],
      ['Al Jazeera Documentary', 'documentary', '', 'https://live-hls-web-ajd.getaj.net/AJD/index.m3u8', testHLS, '', 122],
      ['Nat Geo Wild', 'documentary', '', testHLS, testHLS2, '', 123],
      ['Nat Geo People', 'documentary', '', testHLS2, testHLS, '', 124],
      // ===== Religious =====
      ['Quran TV', 'religious', '', 'https://quraan.akamaized.net/hls/live/2027870/quran2/master.m3u8', testHLS, '', 125],
      ['Sunnah TV', 'religious', '', 'https://sunnah.akamaized.net/hls/live/2027872/sunnah2/master.m3u8', testHLS, '', 126],
      ['Iqraa', 'religious', '', testHLS, testHLS2, '', 127],
      ['Al Resalah', 'religious', '', testHLS2, testHLS, '', 128],
      ['Mecca Live', 'religious', '', 'https://hfrstream1.akamaized.net/hls/live/2003102/alharam/master.m3u8', testHLS, '', 129],
      ['Madina Live', 'religious', '', 'https://mnbrstream1.akamaized.net/hls/live/2003103/almadinah/master.m3u8', testHLS, '', 130],
    ];

    channels.forEach(([name, cat, logo, url, backup, backup2, order]) => {
      run('INSERT INTO channels (name, category, logo_url, stream_url, backup_url, backup_url2, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [name, cat, logo, url, backup || '', backup2 || '', order]);
    });
    console.log(`${channels.length} channels created`);
  }

  // Movies
  const mvCount = getOne('SELECT COUNT(*) as count FROM movies', []);
  if (mvCount.count === 0) {
    // Real playable videos - open source films & public domain
    const realFilms = {
      // Blender Open Movies - working public URLs
      bigBuck: 'https://download.blender.org/peach/bigbuckbunny_movies/big_buck_bunny_1080p_h264.mov',
      elephants: 'https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4',
      sintel: 'https://download.blender.org/durian/trailer/sintel_trailer-1080p.mp4',
      tears: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4',
      // Additional working videos
      v5: 'https://test-videos.co.uk/vids/sintel/mp4/h264/1080/Sintel_1080_10s_1MB.mp4',
      v6: 'https://test-videos.co.uk/vids/jellyfish/mp4/h264/1080/Jellyfish_1080_10s_1MB.mp4',
      v7: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4',
      v8: 'https://test-videos.co.uk/vids/sintel/mp4/h264/720/Sintel_720_10s_1MB.mp4',
      v9: 'https://test-videos.co.uk/vids/jellyfish/mp4/h264/720/Jellyfish_720_10s_1MB.mp4',
      v10: 'https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4',
      v11: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
      v12: 'https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4',
      v13: 'https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4',
    };
    const f = realFilms;

    const movies = [
      // ===== Real Playable Open-Source Films =====
      ['Big Buck Bunny', 'A giant rabbit takes revenge on three bullying rodents - Full animated film by Blender Foundation', 'animation', f.bigBuck, 10, 2008, 8.0],
      ['Elephants Dream', 'Two characters explore a surreal mechanical world - First Blender open movie', 'animation', f.elephants, 11, 2006, 7.5],
      ['Sintel', 'A girl searches for her lost baby dragon in a fantasy world - Award-winning Blender film', 'animation', f.sintel, 15, 2010, 8.2],
      ['Tears of Steel', 'A sci-fi story about love and loss with stunning VFX - Blender Foundation', 'sci-fi', f.tears, 12, 2012, 7.8],

      // ===== Action (with working demo videos) =====
      ['The Dark Knight', 'A hero fights chaos in Gotham City', 'action', f.bigBuck, 152, 2008, 9.0],
      ['Inception', 'A thief enters dreams to plant ideas', 'action', f.elephants, 148, 2010, 8.8],
      ['Mad Max: Fury Road', 'A chase across a desert wasteland', 'action', f.sintel, 120, 2015, 8.1],
      ['John Wick', 'A retired hitman seeks revenge', 'action', f.tears, 101, 2014, 7.4],
      ['Gladiator', 'A Roman general becomes a gladiator', 'action', f.v5, 155, 2000, 8.5],
      ['The Matrix', 'A hacker discovers reality is simulated', 'action', f.v6, 136, 1999, 8.7],
      ['Avengers: Endgame', 'Heroes unite for a final battle', 'action', f.v7, 181, 2019, 8.4],
      ['Top Gun: Maverick', 'A pilot trains elite graduates', 'action', f.v8, 130, 2022, 8.3],
      ['Mission Impossible: Fallout', 'Ethan Hunt races to save the world', 'action', f.v9, 147, 2018, 7.7],
      ['Die Hard', 'An officer fights terrorists in a skyscraper', 'action', f.v10, 132, 1988, 8.2],
      // Comedy
      ['The Hangover', 'Friends lose the groom at a bachelor party', 'comedy', f.bigBuck, 100, 2009, 7.7],
      ['Home Alone', 'A kid defends his home from burglars', 'comedy', f.elephants, 103, 1990, 7.7],
      ['The Mask', 'A man finds a magical mask', 'comedy', f.sintel, 101, 1994, 6.9],
      ['Superbad', 'Teens try to party before graduation', 'comedy', f.v11, 113, 2007, 7.6],
      ['Mean Girls', 'A teen navigates high school cliques', 'comedy', f.v12, 97, 2004, 7.1],
      ['Step Brothers', 'Two adults become step brothers', 'comedy', f.v13, 98, 2008, 6.9],
      // Drama
      ['The Shawshank Redemption', 'A banker survives prison life', 'drama', f.tears, 142, 1994, 9.3],
      ['Forrest Gump', 'A simple man lives through historic events', 'drama', f.bigBuck, 142, 1994, 8.8],
      ['The Godfather', 'A crime family saga', 'drama', f.elephants, 175, 1972, 9.2],
      ['Fight Club', 'An insomniac starts an underground club', 'drama', f.sintel, 139, 1999, 8.8],
      ['Interstellar', 'Explorers travel through a wormhole', 'drama', f.tears, 169, 2014, 8.7],
      ['Parasite', 'Two families from different classes collide', 'drama', f.v5, 132, 2019, 8.5],
      ['Whiplash', 'A drummer pushes his limits', 'drama', f.v6, 106, 2014, 8.5],
      ['The Green Mile', 'A death row officer meets a gifted prisoner', 'drama', f.v7, 189, 1999, 8.6],
      // Horror
      ['The Conjuring', 'Paranormal investigators face a dark presence', 'horror', f.v8, 112, 2013, 7.5],
      ['Get Out', 'A man uncovers a disturbing secret', 'horror', f.v9, 104, 2017, 7.7],
      ['A Quiet Place', 'A family survives in silence', 'horror', f.v10, 90, 2018, 7.5],
      ['It', 'Kids face a terrifying clown', 'horror', f.v11, 135, 2017, 7.3],
      ['Hereditary', 'A family unravels dark secrets', 'horror', f.v12, 127, 2018, 7.3],
      // Sci-Fi
      ['Blade Runner 2049', 'A replicant uncovers a buried secret', 'sci-fi', f.elephants, 164, 2017, 8.0],
      ['Dune', 'A noble family controls a desert planet', 'sci-fi', f.sintel, 155, 2021, 8.0],
      ['The Martian', 'An astronaut survives alone on Mars', 'sci-fi', f.tears, 144, 2015, 8.0],
      ['Arrival', 'A linguist communicates with aliens', 'sci-fi', f.bigBuck, 116, 2016, 7.9],
      ['Ex Machina', 'A programmer evaluates an AI', 'sci-fi', f.v13, 108, 2014, 7.7],
      // Animation
      ['Spider-Man: Into the Spider-Verse', 'A teen becomes Spider-Man', 'animation', f.bigBuck, 117, 2018, 8.4],
      ['Coco', 'A boy enters the Land of the Dead', 'animation', f.sintel, 105, 2017, 8.4],
      ['The Lion King', 'A young lion reclaims his kingdom', 'animation', f.elephants, 88, 1994, 8.5],
      ['Finding Nemo', 'A father searches for his lost son', 'animation', f.tears, 100, 2003, 8.2],
      ['Frozen', 'A queen with ice powers isolates herself', 'animation', f.bigBuck, 102, 2013, 7.4],
      ['Toy Story', 'Toys come to life', 'animation', f.sintel, 81, 1995, 8.3],
      // Arabic
      ['The Blue Elephant', 'A psychiatrist faces supernatural events', 'arabic', f.tears, 135, 2014, 7.8],
      ['The Blue Elephant 2', 'The psychiatrist returns', 'arabic', f.elephants, 133, 2019, 7.2],
      ['Welad Rizk', 'Brothers plan a heist', 'arabic', f.bigBuck, 110, 2015, 7.0],
      ['Welad Rizk 2', 'The brothers face new challenges', 'arabic', f.sintel, 120, 2019, 6.5],
      ['El Gezira', 'A story of power in Upper Egypt', 'arabic', f.tears, 140, 2007, 7.5],
      ['El Gezira 2', 'The saga continues', 'arabic', f.elephants, 145, 2014, 6.8],
      ['Kira w El Gin', 'A dark supernatural thriller', 'arabic', f.bigBuck, 125, 2022, 5.8],
      ['Harb Karmooz', 'Action drama set in Alexandria', 'arabic', f.sintel, 118, 2018, 6.2],
      ['Casablanca', 'A classic romantic drama', 'arabic', f.tears, 130, 2019, 6.0],
    ];

    // Build backup URL rotation from all film URLs
    const allMovieUrls = Object.values(realFilms);
    movies.forEach(([title, desc, cat, url, dur, year, rating], idx) => {
      const backup1 = allMovieUrls[(idx + 1) % allMovieUrls.length];
      const backup2 = allMovieUrls[(idx + 3) % allMovieUrls.length];
      run('INSERT INTO movies (title, description, category, video_url, backup_url, backup_url2, duration, year, rating) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [title, desc, cat, url, backup1 !== url ? backup1 : allMovieUrls[(idx + 2) % allMovieUrls.length], backup2 !== url ? backup2 : allMovieUrls[(idx + 4) % allMovieUrls.length], dur, year, rating]);
    });
    console.log(`${movies.length} movies created`);
  }

  // Series & Episodes
  const serCount = getOne('SELECT COUNT(*) as count FROM series', []);
  if (serCount.count === 0) {
    const epVids = [
      'https://download.blender.org/peach/bigbuckbunny_movies/big_buck_bunny_1080p_h264.mov',
      'https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4',
      'https://download.blender.org/durian/trailer/sintel_trailer-1080p.mp4',
      'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4',
      'https://test-videos.co.uk/vids/sintel/mp4/h264/1080/Sintel_1080_10s_1MB.mp4',
      'https://test-videos.co.uk/vids/jellyfish/mp4/h264/1080/Jellyfish_1080_10s_1MB.mp4',
      'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4',
      'https://test-videos.co.uk/vids/sintel/mp4/h264/720/Sintel_720_10s_1MB.mp4',
      'https://test-videos.co.uk/vids/jellyfish/mp4/h264/720/Jellyfish_720_10s_1MB.mp4',
    ];

    const seriesData = [
      {
        title: 'Breaking Bad', desc: 'A teacher turns to crime to secure his family', cat: 'drama',
        seasons: 5, year: 2008, rating: 9.5,
        episodes: [
          { s: 1, eps: [['Pilot', 58], ['Cat\'s in the Bag...', 48], ['...And the Bag\'s in the River', 48], ['Cancer Man', 48], ['Gray Matter', 48], ['Crazy Handful of Nothin\'', 48], ['A No-Rough-Stuff-Type Deal', 48]] },
          { s: 2, eps: [['Seven Thirty-Seven', 48], ['Grilled', 48], ['Bit by a Dead Bee', 48], ['Down', 48], ['Breakage', 48]] },
          { s: 3, eps: [['No Mas', 48], ['Caballo sin Nombre', 48], ['I.F.T.', 48], ['Green Light', 48], ['Mas', 48]] },
          { s: 4, eps: [['Box Cutter', 48], ['Thirty-Eight Snub', 48], ['Open House', 48], ['Bullet Points', 48], ['Shotgun', 48]] },
          { s: 5, eps: [['Live Free or Die', 48], ['Madrigal', 48], ['Hazard Pay', 48], ['Fifty-One', 48], ['Dead Freight', 48]] },
        ]
      },
      {
        title: 'Game of Thrones', desc: 'Noble families fight for the Iron Throne', cat: 'drama',
        seasons: 8, year: 2011, rating: 9.3,
        episodes: [
          { s: 1, eps: [['Winter Is Coming', 62], ['The Kingsroad', 56], ['Lord Snow', 58], ['Cripples, Bastards, and Broken Things', 56], ['The Wolf and the Lion', 55]] },
          { s: 2, eps: [['The North Remembers', 53], ['The Night Lands', 54], ['What Is Dead May Never Die', 53], ['Garden of Bones', 51], ['The Ghost of Harrenhal', 54]] },
          { s: 3, eps: [['Valar Dohaeris', 55], ['Dark Wings, Dark Words', 58], ['Walk of Punishment', 55], ['And Now His Watch Is Ended', 57], ['Kissed by Fire', 58]] },
        ]
      },
      {
        title: 'Stranger Things', desc: 'Kids uncover supernatural mysteries in their small town', cat: 'sci-fi',
        seasons: 4, year: 2016, rating: 8.7,
        episodes: [
          { s: 1, eps: [['The Vanishing of Will Byers', 49], ['The Weirdo on Maple Street', 56], ['Holly, Jolly', 52], ['The Body', 51], ['The Flea and the Acrobat', 52], ['The Monster', 47], ['The Bathtub', 41], ['The Upside Down', 55]] },
          { s: 2, eps: [['MADMAX', 48], ['Trick or Treat, Freak', 56], ['The Pollywog', 51], ['Will the Wise', 46], ['Dig Dug', 58]] },
        ]
      },
      {
        title: 'Money Heist', desc: 'A genius plans the perfect heist on the Royal Mint', cat: 'action',
        seasons: 5, year: 2017, rating: 8.2,
        episodes: [
          { s: 1, eps: [['Episode 1', 50], ['Episode 2', 45], ['Episode 3', 43], ['Episode 4', 48], ['Episode 5', 47]] },
          { s: 2, eps: [['Episode 1', 52], ['Episode 2', 50], ['Episode 3', 47], ['Episode 4', 55], ['Episode 5', 48]] },
        ]
      },
      {
        title: 'Squid Game', desc: 'Contestants play deadly childhood games for money', cat: 'thriller',
        seasons: 2, year: 2021, rating: 8.0,
        episodes: [
          { s: 1, eps: [['Red Light, Green Light', 60], ['Hell', 62], ['The Man with the Umbrella', 55], ['Stick to the Team', 53], ['A Fair World', 52], ['Gganbu', 59], ['VIPs', 58], ['Front Man', 57], ['One Lucky Day', 63]] },
        ]
      },
      {
        title: 'The Witcher', desc: 'A monster hunter navigates a chaotic world', cat: 'action',
        seasons: 3, year: 2019, rating: 8.2,
        episodes: [
          { s: 1, eps: [['The End\'s Beginning', 61], ['Four Marks', 61], ['Betrayer Moon', 67], ['Of Banquets, Bastards and Burials', 63], ['Bottled Appetites', 63]] },
        ]
      },
      {
        title: 'Wednesday', desc: 'Wednesday Addams investigates mysteries at Nevermore Academy', cat: 'comedy',
        seasons: 1, year: 2022, rating: 8.1,
        episodes: [
          { s: 1, eps: [['Wednesday\'s Child Is Full of Woe', 46], ['Woe Is the Loneliest Number', 50], ['Friend or Woe', 45], ['Woe What a Night', 49], ['You Reap What You Woe', 46], ['Quid Pro Woe', 47], ['If You Don\'t Woe Me by Now', 46], ['A Murder of Woes', 51]] },
        ]
      },
      {
        title: 'The Last of Us', desc: 'Survivors navigate a post-apocalyptic world', cat: 'drama',
        seasons: 2, year: 2023, rating: 8.8,
        episodes: [
          { s: 1, eps: [['When You\'re Lost in the Darkness', 81], ['Infected', 53], ['Long, Long Time', 76], ['Please Hold to My Hand', 50], ['Endure and Survive', 60]] },
        ]
      },
      {
        title: 'House of the Dragon', desc: 'The Targaryen civil war tears Westeros apart', cat: 'drama',
        seasons: 2, year: 2022, rating: 8.4,
        episodes: [
          { s: 1, eps: [['The Heirs of the Dragon', 66], ['The Rogue Prince', 54], ['Second of His Name', 58], ['King of the Narrow Sea', 59], ['We Light the Way', 57]] },
        ]
      },
      {
        title: 'Peaky Blinders', desc: 'A crime family rises in post-war Birmingham', cat: 'drama',
        seasons: 6, year: 2013, rating: 8.8,
        episodes: [
          { s: 1, eps: [['Episode 1', 57], ['Episode 2', 58], ['Episode 3', 59], ['Episode 4', 56], ['Episode 5', 58], ['Episode 6', 59]] },
          { s: 2, eps: [['Episode 1', 59], ['Episode 2', 58], ['Episode 3', 57], ['Episode 4', 59], ['Episode 5', 60], ['Episode 6', 59]] },
        ]
      },
      // Arabic Series
      {
        title: 'El Hashashin', desc: 'Historical drama about the Assassins order', cat: 'arabic-series',
        seasons: 1, year: 2024, rating: 8.5,
        episodes: [
          { s: 1, eps: [['Episode 1', 45], ['Episode 2', 42], ['Episode 3', 44], ['Episode 4', 43], ['Episode 5', 45], ['Episode 6', 42], ['Episode 7', 44], ['Episode 8', 43], ['Episode 9', 45], ['Episode 10', 46]] },
        ]
      },
      {
        title: 'Taye3', desc: 'A journey through Upper Egypt', cat: 'arabic-series',
        seasons: 2, year: 2018, rating: 7.8,
        episodes: [
          { s: 1, eps: [['Episode 1', 42], ['Episode 2', 43], ['Episode 3', 41], ['Episode 4', 42], ['Episode 5', 44]] },
          { s: 2, eps: [['Episode 1', 43], ['Episode 2', 44], ['Episode 3', 42], ['Episode 4', 43], ['Episode 5', 45]] },
        ]
      },
      {
        title: 'Paranormal', desc: 'Egyptian doctor investigates paranormal events', cat: 'arabic-series',
        seasons: 1, year: 2020, rating: 7.2,
        episodes: [
          { s: 1, eps: [['The Myth of the House', 42], ['The Myth of the Cellar', 38], ['The Myth of the Curse', 40], ['The Myth of the Bell', 39], ['The Myth of the Highway', 41], ['The Myth of the Legend', 43]] },
        ]
      },
      {
        title: 'Nehayat El Aalam', desc: 'An apocalyptic Arabic series', cat: 'arabic-series',
        seasons: 1, year: 2023, rating: 6.8,
        episodes: [
          { s: 1, eps: [['Episode 1', 40], ['Episode 2', 42], ['Episode 3', 41], ['Episode 4', 43], ['Episode 5', 42]] },
        ]
      },
      {
        title: 'La Casa De Papel Arabic', desc: 'Arabic adaptation of Money Heist', cat: 'arabic-series',
        seasons: 1, year: 2023, rating: 5.5,
        episodes: [
          { s: 1, eps: [['Episode 1', 48], ['Episode 2', 46], ['Episode 3', 47], ['Episode 4', 49], ['Episode 5', 50], ['Episode 6', 48]] },
        ]
      },
    ];

    let epCounter = 0;
    seriesData.forEach(s => {
      const result = run('INSERT INTO series (title, description, category, total_seasons, year, rating) VALUES (?, ?, ?, ?, ?, ?)',
        [s.title, s.desc, s.cat, s.seasons, s.year, s.rating]);
      const seriesId = result.lastInsertRowid;
      s.episodes.forEach(season => {
        season.eps.forEach(([epTitle, dur], idx) => {
          const vid = epVids[epCounter % epVids.length];
          const bk1 = epVids[(epCounter + 2) % epVids.length];
          const bk2 = epVids[(epCounter + 5) % epVids.length];
          epCounter++;
          run('INSERT INTO episodes (series_id, season, episode_number, title, video_url, backup_url, backup_url2, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [seriesId, season.s, idx + 1, epTitle, vid, bk1, bk2, dur]);
        });
      });
    });
    console.log(`${seriesData.length} series with episodes created`);
  }

  // ===== MIGRATION: Fix broken Google Cloud Storage URLs =====
  // These URLs now return 403 Forbidden, replace with working alternatives
  const brokenUrlMap = {
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4': 'https://download.blender.org/peach/bigbuckbunny_movies/big_buck_bunny_1080p_h264.mov',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4': 'https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4': 'https://download.blender.org/durian/trailer/sintel_trailer-1080p.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4': 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4': 'https://test-videos.co.uk/vids/sintel/mp4/h264/1080/Sintel_1080_10s_1MB.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/VolkswagenGTIReview.mp4': 'https://test-videos.co.uk/vids/jellyfish/mp4/h264/1080/Jellyfish_1080_10s_1MB.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/WeAreGoingOnBullrun.mp4': 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/WhatCarCanYouGetForAGrand.mp4': 'https://test-videos.co.uk/vids/sintel/mp4/h264/720/Sintel_720_10s_1MB.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4': 'https://test-videos.co.uk/vids/jellyfish/mp4/h264/720/Jellyfish_720_10s_1MB.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4': 'https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4': 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4': 'https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4': 'https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4',
    'https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4': 'https://download.blender.org/peach/bigbuckbunny_movies/big_buck_bunny_1080p_h264.mov',
    'https://storage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4': 'https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4',
    'https://storage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4': 'https://download.blender.org/durian/trailer/sintel_trailer-1080p.mp4',
    'https://storage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4': 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4',
  };
  let urlFixCount = 0;
  for (const [oldUrl, newUrl] of Object.entries(brokenUrlMap)) {
    // Fix movies
    db.run('UPDATE movies SET video_url = ? WHERE video_url = ?', [newUrl, oldUrl]);
    db.run('UPDATE movies SET backup_url = ? WHERE backup_url = ?', [newUrl, oldUrl]);
    db.run('UPDATE movies SET backup_url2 = ? WHERE backup_url2 = ?', [newUrl, oldUrl]);
    // Fix episodes
    db.run('UPDATE episodes SET video_url = ? WHERE video_url = ?', [newUrl, oldUrl]);
    db.run('UPDATE episodes SET backup_url = ? WHERE backup_url = ?', [newUrl, oldUrl]);
    db.run('UPDATE episodes SET backup_url2 = ? WHERE backup_url2 = ?', [newUrl, oldUrl]);
  }
  // Also catch any remaining commondatastorage URLs with a fallback
  const fallbackUrl = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4';
  db.run("UPDATE movies SET video_url = ? WHERE video_url LIKE '%commondatastorage.googleapis.com%'", [fallbackUrl]);
  db.run("UPDATE movies SET backup_url = ? WHERE backup_url LIKE '%commondatastorage.googleapis.com%'", [fallbackUrl]);
  db.run("UPDATE movies SET backup_url2 = ? WHERE backup_url2 LIKE '%commondatastorage.googleapis.com%'", [fallbackUrl]);
  db.run("UPDATE episodes SET video_url = ? WHERE video_url LIKE '%commondatastorage.googleapis.com%'", [fallbackUrl]);
  db.run("UPDATE episodes SET backup_url = ? WHERE backup_url LIKE '%commondatastorage.googleapis.com%'", [fallbackUrl]);
  db.run("UPDATE episodes SET backup_url2 = ? WHERE backup_url2 LIKE '%commondatastorage.googleapis.com%'", [fallbackUrl]);
  // Also fix storage.googleapis.com URLs
  db.run("UPDATE movies SET video_url = ? WHERE video_url LIKE '%storage.googleapis.com/gtv-videos%'", [fallbackUrl]);
  db.run("UPDATE movies SET backup_url = ? WHERE backup_url LIKE '%storage.googleapis.com/gtv-videos%'", [fallbackUrl]);
  db.run("UPDATE movies SET backup_url2 = ? WHERE backup_url2 LIKE '%storage.googleapis.com/gtv-videos%'", [fallbackUrl]);
  db.run("UPDATE episodes SET video_url = ? WHERE video_url LIKE '%storage.googleapis.com/gtv-videos%'", [fallbackUrl]);
  db.run("UPDATE episodes SET backup_url = ? WHERE backup_url LIKE '%storage.googleapis.com/gtv-videos%'", [fallbackUrl]);
  db.run("UPDATE episodes SET backup_url2 = ? WHERE backup_url2 LIKE '%storage.googleapis.com/gtv-videos%'", [fallbackUrl]);
  console.log('✅ Fixed all broken Google Cloud Storage video URLs');

  // Print database summary
  const chCount2 = getOne('SELECT COUNT(*) as c FROM channels', []);
  const mvCount2 = getOne('SELECT COUNT(*) as c FROM movies', []);
  const serCount2 = getOne('SELECT COUNT(*) as c FROM series', []);
  const epCount2 = getOne('SELECT COUNT(*) as c FROM episodes', []);
  const usrCount2 = getOne('SELECT COUNT(*) as c FROM users', []);
  const planCount2 = getOne('SELECT COUNT(*) as c FROM subscriptions', []);
  console.log('');
  console.log('📊 Database Summary:');
  console.log(`   Channels: ${chCount2.c} | Movies: ${mvCount2.c} | Series: ${serCount2.c} | Episodes: ${epCount2.c}`);
  console.log(`   Users: ${usrCount2.c} | Plans: ${planCount2.c}`);
  console.log(`   DB Path: ${DB_PATH}`);

  // Save a snapshot of counts to a log file — helps debug data loss
  try {
    const snapshot = {
      time: new Date().toISOString(),
      pid: process.pid,
      source: loadedFrom,
      counts: {
        channels: chCount2.c, movies: mvCount2.c, series: serCount2.c,
        episodes: epCount2.c, users: usrCount2.c, plans: planCount2.c
      }
    };
    const snapshotPath = path.join(BASE_DIR, 'db_snapshots.log');
    fs.appendFileSync(snapshotPath, JSON.stringify(snapshot) + '\n');
    console.log('   📋 Snapshot saved to db_snapshots.log');
  } catch(e) {}
  console.log('');

  // Final save after all init/migration is done
  saveDb();
  _dbReady = true;
  return db;
}

// Helper functions
function run(sql, params = []) {
  // Log DELETE operations to help debug data loss
  const sqlLower = sql.trim().toLowerCase();
  if (sqlLower.startsWith('delete')) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] DELETE: ${sql} | params: ${JSON.stringify(params)}\n`;
    console.log('⚠️ DB DELETE:', sql, params);
    try {
      fs.appendFileSync(path.join(BASE_DIR, 'delete_log.txt'), logLine);
    } catch(e) {}
  }
  db.run(sql, params);
  const result = db.exec('SELECT last_insert_rowid() as id');
  const lastId = result.length > 0 ? result[0].values[0][0] : 0;
  // Schedule a save (debounced) instead of saving immediately
  // This groups rapid writes (like bulk imports) into one save
  scheduleSave();
  return { lastInsertRowid: lastId };
}

function getOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const result = stmt.getAsObject();
    stmt.free();
    return result;
  }
  stmt.free();
  return null;
}

function getAll(sql, params = []) {
  const results = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

module.exports = { init, run, getOne, getAll, saveDb };
