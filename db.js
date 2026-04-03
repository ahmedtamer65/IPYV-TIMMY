const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const DB_PATH = path.join(BASE_DIR, 'iptv.db');

let db = null;

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

setInterval(() => { if (db) saveDb(); }, 30000);

async function init() {
  const SQL = await initSqlJs();

  // Force reset if RESET_DB env or if .reset file exists
  const resetFile = path.join(BASE_DIR, '.reset_db');
  if (fs.existsSync(resetFile) || process.env.RESET_DB) {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    if (fs.existsSync(resetFile)) fs.unlinkSync(resetFile);
    console.log('Database reset forced!');
  }

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

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
    created_at TEXT DEFAULT (datetime('now'))
  )`);

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
    created_at TEXT DEFAULT (datetime('now'))
  )`);

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
      // Blender Open Movies (real full films, free & open source)
      bigBuck: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
      elephants: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
      sintel: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
      tears: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
      // Additional working videos
      v5: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4',
      v6: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/VolkswagenGTIReview.mp4',
      v7: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/WeAreGoingOnBullrun.mp4',
      v8: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/WhatCarCanYouGetForAGrand.mp4',
      v9: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
      v10: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
      v11: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
      v12: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
      v13: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4',
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
      'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
      'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
      'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
      'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
      'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
      'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
      'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
      'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
      'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4',
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

  saveDb();
  return db;
}

// Helper functions
function run(sql, params = []) {
  db.run(sql, params);
  const result = db.exec('SELECT last_insert_rowid() as id');
  const lastId = result.length > 0 ? result[0].values[0][0] : 0;
  saveDb();
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
