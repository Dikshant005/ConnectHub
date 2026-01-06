const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true, trim: true },
  email: { type: String, unique: true, required: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  resetPasswordTokenHash: { type: String },
  resetPasswordTokenExpires: { type: Date },
}, { timestamps: true });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
