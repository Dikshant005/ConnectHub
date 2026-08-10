const mongoose = require('mongoose');

const chunkSchema = new mongoose.Schema({
  meetingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting', required: true },
  index: { type: Number, required: true },
  url: { type: String, required: true },
  transcript: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});

const Chunk = mongoose.model('Chunk', chunkSchema);
module.exports = Chunk;
