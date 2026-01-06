const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const meetingRoutes = require("./routes/meeting");
const authMiddleware = require('./middleware/authMiddleware');
const Message = require('./models/message');
const chatRoutes = require('./routes/chat.js');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const app = express();

// Will be initialized after the HTTP server is created.
// We attach it to req/app so routes can emit socket events.
let io;

const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://connect-hub-virid.vercel.app";

app.use(cors({
  origin: [FRONTEND_URL, "http://localhost:5173"],
  credentials: true,
}));

app.use(bodyParser.json());

// Make Socket.IO available inside routes as `req.io`.
// Note: `io` is assigned before server starts listening.
app.use((req, _res, next) => {
  req.io = io;
  next();
});

app.use('/chat', chatRoutes);
app.use('/auth', authRoutes);
app.use('/meetings', authMiddleware, meetingRoutes);

const mongoUri = process.env.MONGO_URI;
mongoose.connect(mongoUri)
  .then(() => console.log('✅ DB connected'))
  .catch(err => {
    console.error('❌ Mongo error:', err.message);
    process.exit(1);
  });

const server = http.createServer(app);
io = new Server(server, {
  cors: {
    origin: [FRONTEND_URL, "http://localhost:5173"],
    credentials: true,
  },
});

// Also expose through app for any future access pattern.
app.set('io', io);

/* ======================================================
   ✅ SINGLE SOURCE OF TRUTH (IMPORTANT)
====================================================== */

const roomUsers = new Map(); 
// roomId -> Map<userId, socketId>

const socketMeta = new Map(); 
// socketId -> { roomId, userId }

const roomScreenShares = new Map();
// roomId -> userId

/* ======================================================
   SOCKET LOGIC
====================================================== */

io.on('connection', (socket) => {
  console.log('🟢 Connected:', socket.id);

  /* ---------------- JOIN ROOM ---------------- */

  socket.on('join-room', (roomId, userId) => {
    if (!roomId || !userId) return;

    if (!roomUsers.has(roomId)) {
      roomUsers.set(roomId, new Map());
    }

    const users = roomUsers.get(roomId);

    // Prevent duplicate joins
    if (users.has(userId)) {
      console.log('ℹ️ User already joined, ignoring');
      return;
    }

    if (users.size >= 2) {
      socket.emit('room-full');
      return;
    }

    users.set(userId, socket.id);
    socketMeta.set(socket.id, { roomId, userId });
    socket.join(roomId);

    console.log(`✅ ${userId} joined ${roomId}`);

    // Notify others
    socket.to(roomId).emit('user-connected', userId);
  });

  /* ---------------- MIC STATUS ---------------- */

  // Client emits: socket.emit('mic-toggle', { isMicOn: true/false })
  // Server broadcasts to room: 'peer-mic-state' with { userId, isMicOn }
  socket.on('mic-toggle', ({ isMicOn } = {}) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    if (typeof isMicOn !== 'boolean') return;

    const { roomId, userId } = meta;

    socket.to(roomId).emit('peer-mic-state', {
      userId,
      isMicOn,
    });
  });

  /* ---------------- SIGNAL ---------------- */

  socket.on('signal', (toUserId, data) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const { roomId, userId } = meta;
    const users = roomUsers.get(roomId);
    const toSocketId = users?.get(toUserId);

    if (toSocketId) {
      io.to(toSocketId).emit('signal', userId, data);
    }
  });

  /* ---------------- ICE ---------------- */

  socket.on('ice-candidate', ({ toUserId, candidate }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || !candidate) return;

    const { roomId, userId } = meta;
    const users = roomUsers.get(roomId);
    const toSocketId = users?.get(toUserId);

    if (toSocketId) {
      io.to(toSocketId).emit('ice-candidate', {
        fromUserId: userId,
        candidate,
      });
    }
  });

  /* ---------------- CHAT ---------------- */

  socket.on('send-chat-message', async (data) => {
    const { roomId, senderId, senderName, message } = data;

    const newMessage = new Message({
      meetingId: roomId,
      senderId,
      senderName,
      text: message
    });

    await newMessage.save();
    io.to(roomId).emit('receive-chat-message', newMessage);
  });

  /* ---------------- SCREEN SHARE ---------------- */

  socket.on('start-screen-share', ({ roomId }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const current = roomScreenShares.get(roomId);
    if (current && current !== meta.userId) {
      socket.emit('screen-share-error', { message: 'Already sharing' });
      return;
    }

    roomScreenShares.set(roomId, meta.userId);
    socket.to(roomId).emit('user-started-screen-share', meta.userId);
  });

  socket.on('stop-screen-share', ({ roomId }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    if (roomScreenShares.get(roomId) === meta.userId) {
      roomScreenShares.delete(roomId);
      socket.to(roomId).emit('user-stopped-screen-share', meta.userId);
    }
  });

  /* ---------------- DISCONNECT ---------------- */

  socket.on('disconnect', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const { roomId, userId } = meta;
    const users = roomUsers.get(roomId);

    if (users) {
      users.delete(userId);
      if (users.size === 0) roomUsers.delete(roomId);
    }

    if (roomScreenShares.get(roomId) === userId) {
      roomScreenShares.delete(roomId);
      socket.to(roomId).emit('user-stopped-screen-share', userId);
    }

    socket.to(roomId).emit('user-disconnected', userId);
    socketMeta.delete(socket.id);

    console.log(`🔴 ${userId} disconnected`);
  });
});

/* ======================================================
   SERVER START
====================================================== */

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
});
