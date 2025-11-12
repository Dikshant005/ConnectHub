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

// CORS configuration
const FRONTEND_URL = "http://localhost:5173";
app.use(cors({ origin: FRONTEND_URL,
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

// Socket.io Signaling Server
const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
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
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});