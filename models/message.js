const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  meetingId: { type: String, required: true }, // We will use the 'roomId' (e.g., 123456)
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderName: { type: String, required: true }, // Cache name to avoid extra DB lookups
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
});
messageSchema.index({ meetingId: 1, timestamp: 1 });

module.exports = mongoose.model('Message', messageSchema);