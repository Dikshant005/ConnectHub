const mongoose = require('mongoose');

const meetingSchema = new mongoose.Schema({
  title: { type: String, required: true },
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  host_id: { type: String },
  roomId: { type: String, required: true, unique: true },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  scheduledAt: { type: Date, required: true },
  status: { type: String, default: 'active' },
  ended_at: { type: Date },
  recordingUrl: { type: String },
  transcript: { type: String },
  report: { type: Object },
  createdAt: { type: Date, default: Date.now },
});

const Meeting = mongoose.model('Meeting', meetingSchema);
module.exports = Meeting;
