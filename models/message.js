const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  meetingId: { type: String, required: true }, 
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderName: { type: String, required: true },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
});
messageSchema.index({ meetingId: 1, timestamp: 1 });

module.exports = mongoose.model('Message', messageSchema);
