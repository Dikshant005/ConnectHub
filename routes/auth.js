const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const User = require('../models/user');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret';

const getRequestMeta = (req) => ({
  method: req.method,
  path: req.originalUrl,
  ip: req.ip,
  userAgent: req.get('user-agent'),
});

const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://connect-hub-virid.vercel.app";

const createMailer = () => {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    return null;
  }

  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
};

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
      username: user.username,
      email:user.email,
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

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const normalizedEmail = String(email).toLowerCase().trim();
  const meta = getRequestMeta(req);
  console.info('[auth][forgot-password] request', { ...meta, email: normalizedEmail });

  try {
    const user = await User.findOne({ email: normalizedEmail });

    // Always return success to avoid user enumeration.
    if (!user) {
      console.info('[auth][forgot-password] no matching user', { ...meta, email: normalizedEmail });
      return res.json({ message: 'If that email exists, a reset token has been generated.' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');

    user.resetPasswordTokenHash = tokenHash;
    user.resetPasswordTokenExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();

    console.info('[auth][forgot-password] reset token generated', {
      ...meta,
      userId: String(user._id),
      tokenExpiresAt: user.resetPasswordTokenExpires,
    });

    const transporter = createMailer();
    if (!transporter) {
      console.error('[auth][forgot-password] smtp not configured', { ...meta, userId: String(user._id) });
      return res.status(500).json({
        error: 'SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (and optionally SMTP_SECURE, FROM_EMAIL).'
      });
    }

    const resetLink = `${FRONTEND_URL}/reset-password?token=${resetToken}`;
    const fromEmail = process.env.FROM_EMAIL || process.env.SMTP_USER;

    const mailOptions = {
      from: fromEmail,
      to: user.email,
      subject: 'Reset your password',
      html: `
        <p>You requested a password reset.</p>
        <p>Reset link (valid for 1 hour):</p>
        <p><a href="${resetLink}">${resetLink}</a></p>
        <p>If you did not request this, you can ignore this email.</p>
      `,
    };

    console.info('[auth][forgot-password] sending reset email', {
      ...meta,
      userId: String(user._id),
      from: fromEmail,
      to: user.email,
      smtp: {
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
      },
    });

    const info = await transporter.sendMail(mailOptions);

    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.info('[auth][forgot-password] email preview url', {
        ...meta,
        userId: String(user._id),
        previewUrl,
      });
    }

    console.info('[auth][forgot-password] reset email sent', {
      ...meta,
      userId: String(user._id),
      messageId: info?.messageId,
      accepted: info?.accepted,
      rejected: info?.rejected,
      response: info?.response,
    });

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (error) {
    console.error('[auth][forgot-password] error', {
      ...meta,
      email: normalizedEmail,
      error: error?.message,
      code: error?.code,
      command: error?.command,
      response: error?.response,
      responseCode: error?.responseCode,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!newPassword) return res.status(400).json({ error: 'newPassword is required' });

  const meta = getRequestMeta(req);
  const hasResetToken = Boolean(token);

  try {
    // 1) If caller is logged in, allow simple reset with JWT.
    const bearerToken = getTokenFromHeader(req);
    console.info('[auth][reset-password] request', {
      ...meta,
      hasBearerToken: Boolean(bearerToken),
      hasResetToken,
    });

    if (bearerToken) {
      if (blacklistedTokens.has(bearerToken)) {
        console.warn('[auth][reset-password] bearer token blacklisted', meta);
        return res.status(403).json({ error: 'Token is invalid (logged out).' });
      }

      const decoded = jwt.verify(bearerToken, JWT_SECRET);
      const user = await User.findById(decoded.userId);
      if (!user) return res.status(400).json({ error: 'User not found' });

      const hashedPassword = await bcrypt.hash(String(newPassword), 10);
      user.password = hashedPassword;
      user.resetPasswordTokenHash = undefined;
      user.resetPasswordTokenExpires = undefined;
      await user.save();

      console.info('[auth][reset-password] success via bearer token', {
        ...meta,
        userId: String(user._id),
      });

      return res.json({ message: 'Password reset successful' });
    }

    // 2) Otherwise use the reset token flow.
    if (!token) {
      console.warn('[auth][reset-password] missing reset token', meta);
      return res.status(400).json({ error: 'token is required' });
    }

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const user = await User.findOne({
      resetPasswordTokenHash: tokenHash,
      resetPasswordTokenExpires: { $gt: new Date() },
    });

    if (!user) {
      console.warn('[auth][reset-password] invalid or expired reset token', {
        ...meta,
        tokenHashPrefix: tokenHash.slice(0, 8),
      });
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const hashedPassword = await bcrypt.hash(String(newPassword), 10);
    user.password = hashedPassword;
    user.resetPasswordTokenHash = undefined;
    user.resetPasswordTokenExpires = undefined;
    await user.save();

    console.info('[auth][reset-password] success via reset token', {
      ...meta,
      userId: String(user._id),
    });

    res.json({ message: 'Password reset successful' });
  } catch (error) {
    console.error('[auth][reset-password] error', { ...meta, error: error?.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;