const express = require('express');
const router = express.Router();
const Message = require('../models/message');
const authMiddleware = require('../middleware/authMiddleware');

router.get('/:roomId', authMiddleware, async (req, res) => {
  try {
    const { roomId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    
    const messages = await Message.find({ meetingId: roomId })
      .sort({ timestamp: 1 })
      .skip(skip)
      .limit(limit);
      
    res.json(messages);
  } catch (err) {
    console.error("Error fetching chat:", err);
    res.status(500).json({ error: 'Could not load chat history' });
  }
});

module.exports = router;
