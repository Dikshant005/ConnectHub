const express = require('express');
const router = express.Router();
const Meeting = require("../models/meeting");
const authMiddleware = require('../middleware/authMiddleware');

// Create meeting
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { title, scheduledAt } = req.body;
    if (!title || !scheduledAt) {
      return res.status(400).json({ error: 'Title and scheduledAt are required' });
    }

    // generate a unique 6-digit room id
    const generateRoomId = () => Math.floor(100000 + Math.random() * 900000).toString();
    let roomId = generateRoomId();
    // ensure uniqueness
    while (await Meeting.findOne({ roomId })) {
      roomId = generateRoomId();
    }

    const meeting = new Meeting({
      title,
      scheduledAt,
      creator: req.user.userId,
      participants: [req.user.userId], // creator is default participant
      roomId,
    });

    await meeting.save();
    res.status(201).json(meeting);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Join meeting - by id (param) or by room number supplied in body { room: '123456' }
router.post('/:id/join', authMiddleware, async (req, res) => {
  try {
    const { room } = req.body;
    let meeting;

    if (room) {
      // find by room id
      meeting = await Meeting.findOne({ roomId: room });
      if (!meeting) return res.status(404).json({ error: 'Meeting with that room not found' });
    } else {
      meeting = await Meeting.findById(req.params.id);
      if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    }

    if (meeting.participants.includes(req.user.userId)) {
      return res.status(400).json({ error: 'Already joined' });
    }

    meeting.participants.push(req.user.userId);
    await meeting.save();
    res.json({ message: 'Joined meeting', meeting });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
