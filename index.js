const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const authRoutes = require('./routes/auth');
const meetingRoutes = require("./routes/meeting");
const authMiddleware = require('./middleware/authMiddleware');
require('dotenv').config();

const app = express();

// ✅ Fix: define CORS origins properly
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://connect-hub-virid.vercel.app";

app.use(cors({
  origin: [FRONTEND_URL, "http://localhost:5173"], // allow both
  credentials: true,
}));

app.use(bodyParser.json());

const mongoUri = process.env.MONGO_URI;
mongoose.connect(mongoUri)
  .then(() => console.log('DB connected'))
  .catch(err => {
    console.error('MongoDB Connection Error:', err.message);
    process.exit(1);
  });

app.use('/auth', authRoutes);
app.use('/meetings', authMiddleware, meetingRoutes);

const server = http.createServer(app);

// ✅ Same fix for Socket.io
const io = new Server(server, {
  cors: {
    origin: [FRONTEND_URL, "http://localhost:5173"],
    credentials: true,
  },
});
const activeConnections = new Map(); // socketId -> { roomId, userId }
const userToSocket = new Map();

io.on('connection', (socket) => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🟢 CLIENT CONNECTED');
  console.log(`   Socket ID: ${socket.id}`);
  console.log(`   Time: ${new Date().toISOString()}`);
  console.log(`   Total connections: ${io.engine.clientsCount}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  let currentRoom = null;
  let currentUserId = null;

  socket.on('join-room', (roomId, userId) => {
    console.log('\n📥 JOIN-ROOM EVENT RECEIVED');
    console.log(`   Socket ID: ${socket.id}`);
    console.log(`   Room ID: ${roomId}`);
    console.log(`   User ID: ${userId}`);
    
    currentRoom = roomId;
    currentUserId = userId;
    
    // Track connection
    activeConnections.set(socket.id, { roomId, userId });
    userToSocket.set(userId, socket.id); // ✅ Map userId to socketId
    socket.join(roomId);
    console.log(`✅ User ${userId} joined room ${roomId}`);
    
    // Get room info
    const roomSize = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    console.log(`   Room size: ${roomSize} participant(s)`);
    
    // Notify others in room
    socket.to(roomId).emit('user-connected', userId);
    console.log(`📤 Notified room ${roomId} about new user ${userId}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  });

  // ✅ CORRECT: Define listeners at connection level
  socket.on('signal', (toUserId, data) => {
    console.log('\n🔄 SIGNAL EVENT RECEIVED');
    console.log(`   From Socket: ${socket.id}`);
    console.log(`   From User: ${currentUserId}`);
    console.log(`   To User: ${toUserId}`);
    console.log(`   Data type: ${data?.type || 'unknown'}`);
    
     const toSocketId = userToSocket.get(toUserId);
    
    if (toSocketId) {
      console.log(`   To Socket: ${toSocketId}`);
      io.to(toSocketId).emit('signal', currentUserId, data);
      console.log(`📤 Signal forwarded to socket ${toSocketId} (user ${toUserId})`);
    } else {
      console.error(`❌ No socket found for user ${toUserId}`);
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  });

  socket.on('ice-candidate', (data) => {
    const { toUserId, candidate } = data;
    
    console.log('\n🧊 ICE CANDIDATE RECEIVED');
    console.log(`   From Socket: ${socket.id}`);
    console.log(`   From User: ${currentUserId}`);
    console.log(`   To User: ${toUserId}`);
    
     const toSocketId = userToSocket.get(toUserId);
    
    if (toSocketId) {
      console.log(`   To Socket: ${toSocketId}`);
      io.to(toSocketId).emit('ice-candidate', {
        fromSocketId: socket.id,
        fromUserId: currentUserId,
        candidate: candidate
      });
      console.log(`📤 ICE candidate forwarded to socket ${toSocketId} (user ${toUserId})`);
    } else {
      console.error(`❌ No socket found for user ${toUserId}`);
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  });

  socket.on('disconnect', () => {
    console.log('\n🔴 CLIENT DISCONNECTED');
    console.log(`   Socket ID: ${socket.id}`);
    console.log(`   Time: ${new Date().toISOString()}`);
    console.log(`   Room: ${currentRoom || 'none'}`);
    console.log(`   User ID: ${currentUserId || 'none'}`);
    
    if (currentRoom && currentUserId) {
      socket.to(currentRoom).emit('user-disconnected', currentUserId);
      console.log(`📤 Notified room ${currentRoom} about user ${currentUserId} leaving`);
      
      // Update room size
      const roomSize = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
      console.log(`   Remaining in room: ${roomSize} participant(s)`);
    }
    
    // Remove from tracking
    activeConnections.delete(socket.id);
    console.log(`   Total connections: ${io.engine.clientsCount}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  });

  // ✅ Log any other events for debugging
  socket.onAny((eventName, ...args) => {
    if (!['join-room', 'signal', 'disconnect'].includes(eventName)) {
      console.log(`\n⚡ UNKNOWN EVENT: ${eventName}`);
      console.log(`   Socket ID: ${socket.id}`);
      console.log(`   Args:`, args);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready`);
  console.log(`🌐 CORS enabled for: ${FRONTEND_URL}, http://localhost:5173\n`);
});