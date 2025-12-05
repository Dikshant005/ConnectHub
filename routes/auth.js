const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/user');

const router = express.Router();
const JWT_SECRET = 'secret'; // NOTE: In production, use process.env.JWT_SECRET

// 1. In-memory blacklist for logout (Reset when server restarts)
const blacklistedTokens = new Set();

// 2. Helper function to extract token
const getTokenFromHeader = (req) => {
  const authHeader = req.headers['authorization'];
  // Format is usually "Bearer <token>"
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }
  return null;
};

// 3. The Missing Middleware
const authenticateToken = (req, res, next) => {
  const token = getTokenFromHeader(req);

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  // Check if token is in the blacklist (logged out)
  if (blacklistedTokens.has(token)) {
    return res.status(403).json({ error: 'Token is invalid (logged out).' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // Attach user info to the request object
    next(); // Move to the next function (the route handler)
  } catch (err) {
    res.status(403).json({ error: 'Invalid token.' });
  }
};

// --- ROUTES ---

// Signup
router.post('/signup', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email and password are required' });
  }

  try {
    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
    if (existingUser) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ username, email, password: hashedPassword, isVerified: true });
    await newUser.save();
    res.status(201).json({ message: 'User created successfully.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login
router.post('/login', async (req, res) => {
  const { email, username, password } = req.body;
  if ((!email && !username) || !password) return res.status(400).json({ error: 'Email/username and password are required' });

  try {
    const query = email ? { email } : { username };
    const user = await User.findOne(query);
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '1h' });
    res.json({
      token,
      userId: user._id
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout
router.post('/logout', authenticateToken, (req, res) => {
  const token = getTokenFromHeader(req);
  if (token) {
    blacklistedTokens.add(token);
  }
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;