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

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join-room', (roomId, userId) => {
    socket.join(roomId);
    socket.to(roomId).emit('user-connected', userId);

    socket.on('signal', (toUserId, data) => {
      io.to(toUserId).emit('signal', socket.id, data);
    });

    socket.on('disconnect', () => {
      socket.to(roomId).emit('user-disconnected', userId);
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
