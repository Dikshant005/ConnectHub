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
const Message = require('./models/message');
const chatRoutes = require('./routes/chat');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Initialize AI (Get API Key from https://aistudio.google.com/)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });


const app = express();

// ✅ Fix: define CORS origins properly
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://connect-hub-virid.vercel.app";

app.use(cors({
  origin: [FRONTEND_URL, "http://localhost:5173"], // allow both
  credentials: true,
}));

app.use(bodyParser.json());
app.use((req, res, next) => {
  req.io = io;
  next();
});
app.use('/chat', chatRoutes);

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
const roomScreenShares = new Map(); // ✅ NEW: roomId -> userId (Tracks who is sharing)

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

  
  socket.on('send-chat-message', async (data) => {
    const { roomId, senderId, senderName, message } = data;
    
    console.log(`\n💬 CHAT MESSAGE in Room ${roomId}`);
    console.log(`   From: ${senderName} (${senderId})`);
    console.log(`   Message: ${message}`);

    try {
      // 1. Save to Database
      const newMessage = new Message({
        meetingId: roomId,
        senderId,
        senderName,
        text: message
      });
      await newMessage.save();

      // 2. Broadcast to EVERYONE in the room (including sender)
      // We use io.to() instead of socket.to() so the sender also receives 
      // the confirmation that the server processed it.
      io.to(roomId).emit('receive-chat-message', newMessage);
      
    } catch (err) {
      console.error('❌ Error saving/sending message:', err);
    }
  });

  // Auto complete feature
  socket.on('request-autocomplete', async (currentText) => {
    if (!currentText || currentText.length < 5) return;

    try {
      const prompt = `
        You are an autocomplete engine.
        User typed: "${currentText}"
        Return ONLY the suffix to complete the sentence logically.
        No quotes, no explanations.
        Example: "How a" -> "re you?"
      `;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      const suggestion = response.text().trim();

      if (suggestion) {
        socket.emit('receive-autocomplete', { 
          original: currentText, 
          suggestion: suggestion 
        });
      }
    } catch (err) {
      // Fail silently
    }
  });
  // 

  // ----------------------------------------------------
  // ✅ NEW: SCREEN SHARE LOGIC
  // ----------------------------------------------------

  socket.on('start-screen-share', ({ roomId }) => {
    console.log(`\n🖥️ START SCREEN SHARE Request`);
    console.log(`   Room: ${roomId}, User: ${currentUserId}`);

    // Check if someone else is already sharing
    const currentSharer = roomScreenShares.get(roomId);
    
    if (currentSharer && currentSharer !== currentUserId) {
      // Reject if someone else is sharing
      socket.emit('screen-share-error', { message: 'Someone is already sharing screen' });
      console.log(`❌ Rejected: User ${currentSharer} is already sharing`);
      return;
    }

    // Mark this user as the sharer
    roomScreenShares.set(roomId, currentUserId);

    // Notify others
    socket.to(roomId).emit('user-started-screen-share', currentUserId);
    console.log(`✅ User ${currentUserId} started screen sharing in room ${roomId}`);
  });

  socket.on('stop-screen-share', ({ roomId }) => {
    console.log(`\n🛑 STOP SCREEN SHARE Request`);
    console.log(`   Room: ${roomId}, User: ${currentUserId}`);

    const currentSharer = roomScreenShares.get(roomId);

    if (currentSharer === currentUserId) {
      roomScreenShares.delete(roomId);
      socket.to(roomId).emit('user-stopped-screen-share', currentUserId);
      console.log(`✅ Screen share stopped in room ${roomId}`);
    }
  });

  // ----------------------------------------------------

  socket.on('disconnect', () => {
    console.log('\n🔴 CLIENT DISCONNECTED');
    console.log(`   Socket ID: ${socket.id}`);
    console.log(`   Time: ${new Date().toISOString()}`);
    console.log(`   Room: ${currentRoom || 'none'}`);
    console.log(`   User ID: ${currentUserId || 'none'}`);
    
    if (currentRoom && currentUserId) {
      // ✅ NEW: Handle screen share disconnect
      if (roomScreenShares.get(currentRoom) === currentUserId) {
        console.log(`⚠️ Screen sharer disconnected. Clearing screen share status.`);
        roomScreenShares.delete(currentRoom);
        socket.to(currentRoom).emit('user-stopped-screen-share', currentUserId);
      }

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
    if (!['join-room', 'signal', 'disconnect', 'send-chat-message'].includes(eventName)) {
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