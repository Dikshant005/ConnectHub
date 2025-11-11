const nodemailer = require('nodemailer');
require('dotenv').config(); // Load .env variables first

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_EMAIL = process.env.FROM_EMAIL || 'no-reply@connecthub.local';

// Debug: log the values
console.log('[Mailer Debug] SMTP_HOST:', SMTP_HOST);
console.log('[Mailer Debug] SMTP_PORT:', SMTP_PORT);
console.log('[Mailer Debug] SMTP_USER:', SMTP_USER);
console.log('[Mailer Debug] SMTP_PASS:', SMTP_PASS ? '***' : 'undefined');
console.log('[Mailer Debug] FROM_EMAIL:', FROM_EMAIL);

let transporter;
if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS) {
  console.log('[Mailer] Initializing SMTP transporter...');
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10),
    secure: parseInt(SMTP_PORT, 10) === 465, // true for 465, false for other ports
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
  console.log('[Mailer] ✓ SMTP configured successfully');
} else {
  console.log('[Mailer] ⚠ SMTP not configured - using console fallback');
  // fallback - logs emails to console
  transporter = {
    sendMail: async (options) => {
      console.log('=== Email skipped (no SMTP configured) ===');
      console.log(options);
      return Promise.resolve();
    },
  };
}

async function sendVerifyEmail(to, username, verifyUrl) {
  const subject = 'Verify your ConnectHub account';
  const html = `<p>Hi ${username},</p><p>Please verify your email by clicking the link below:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`;
  return transporter.sendMail({ from: FROM_EMAIL, to, subject, html });
}

async function sendResetEmail(to, username, resetUrl) {
  const subject = 'Reset your ConnectHub password';
  const html = `<p>Hi ${username},</p><p>You (or someone) requested a password reset. Click the link below to set a new password (expires in 1 hour):</p><p><a href="${resetUrl}">${resetUrl}</a></p>`;
  return transporter.sendMail({ from: FROM_EMAIL, to, subject, html });
}

module.exports = { sendVerifyEmail, sendResetEmail };
