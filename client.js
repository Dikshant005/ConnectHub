const { io } = require('socket.io-client');

const socket = io('http://localhost:3000');

socket.on('connect', () => {
  console.log('Connected:', socket.id);
  socket.emit('join-room', 'testRoom', socket.id);
});

socket.on('user-connected', (userId) => {
  console.log('User connected:', userId);
});

socket.on('signal', (from, data) => {
  console.log('Signal from', from, data);
});
