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

    const meeting = new Meeting({
      title,
      scheduledAt,
      creator: req.user.userId,
      participants: [req.user.userId], // creator is default participant
    });

    await meeting.save();
    res.status(201).json(meeting);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Join meeting
router.post('/:id/join', authMiddleware, async (req, res) => {
  try {
    const meeting = await Meeting.findById(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

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
