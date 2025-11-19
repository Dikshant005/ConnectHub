const express = require('express');
const router = express.Router();
const Meeting = require("../models/meeting");
const authMiddleware = require('../middleware/authMiddleware');

// ---------- CREATE MEETING ----------
router.post('/', authMiddleware, async (req, res) => {
  console.log("➡️ CREATE MEETING API HIT");

  try {
    const { title, scheduledAt } = req.body;

    // Missing fields
    if (!title || !scheduledAt) {
      console.log("❌ Missing title or scheduledAt");
      return res.status(400).json({ error: 'Title and scheduledAt are required' });
    }

    console.log("📌 Request body:", req.body);
    console.log("👤 User:", req.user);

    // Generate unique 6-digit room ID
    const generateRoomId = () =>
      Math.floor(100000 + Math.random() * 900000).toString();

    let roomId = generateRoomId();
    console.log("🔄 Generated room ID:", roomId);

    // Ensure unique room ID
    while (await Meeting.findOne({ roomId })) {
      console.log("⚠️ Room ID already exists. Regenerating...");
      roomId = generateRoomId();
    }

    console.log("✅ Final room ID:", roomId);

    // Create meeting
    const meeting = new Meeting({
      title,
      scheduledAt,
      creator: req.user.userId,
      participants: [req.user.userId],
      roomId,
    });

    await meeting.save();
    console.log("🎉 Meeting created successfully:", meeting);

    res.status(201).json(meeting);

  } catch (err) {
    console.log("💥 Error creating meeting:", err.message);
    res.status(500).json({ error: err.message });
  }
});


// ---------- JOIN MEETING ----------
router.post('/:id/join', authMiddleware, async (req, res) => {
  console.log("➡️ JOIN MEETING API HIT");

  try {
    const room = req.body.room || req.body.roomId;  // ← FIXED
    console.log("📌 Params ID:", req.params.id);
    console.log("📌 Body:", req.body);

    let meeting;

    if (room) {
      console.log("🔎 Searching by room ID:", room);
      meeting = await Meeting.findOne({ roomId: room });
      if (!meeting) {
        console.log("❌ No meeting found with room:", room);
        return res.status(404).json({ error: 'Meeting with that room not found' });
      }
      console.log("✅ Meeting found by room ID:", meeting._id);
    } else {
      console.log("🔎 Searching by meeting ID:", req.params.id);
      meeting = await Meeting.findById(req.params.id);
      if (!meeting) {
        console.log("❌ Meeting not found with ID:", req.params.id);
        return res.status(404).json({ error: 'Meeting not found' });
      }
      console.log("✅ Meeting found by ID:", meeting._id);
    }

    if (meeting.participants.includes(req.user.userId)) {
      console.log("⚠️ User already a participant");
      return res.status(400).json({ error: 'Already joined' });
    }

    console.log("➕ Adding participant:", req.user.userId);
    meeting.participants.push(req.user.userId);
    await meeting.save();

    console.log("🎉 User successfully joined meeting:", meeting._id);
    res.json({ message: 'Joined meeting', meeting });

  } catch (err) {
    console.log("💥 Error joining meeting:", err.message);
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;
