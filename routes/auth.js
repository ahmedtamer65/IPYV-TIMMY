const express = require('express');
const bcrypt = require('bcryptjs');
const { run, getOne } = require('../db');
const { generateToken } = require('../middleware/auth');

const router = express.Router();

// Register
router.post('/register', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }
    const existing = getOne('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    const hash = bcrypt.hashSync(password, 10);
    const result = run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hash]);
    const user = getOne('SELECT * FROM users WHERE id = ?', [result.lastInsertRowid]);
    const token = generateToken(user);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, subscription: user.subscription } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;
    const user = getOne('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is deactivated' });
    }
    run('UPDATE users SET last_login = datetime("now") WHERE id = ?', [user.id]);
    const token = generateToken(user);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, subscription: user.subscription } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
