const express = require('express');
const router = express.Router();
const Message = require('../models/message');
const authMiddleware = require('../middleware/authMiddleware');

router.get('/:roomId', authMiddleware, async (req, res) => {
  try {
    const { roomId } = req.params;
    
    const messages = await Message.find({ meetingId: roomId }).sort({ timestamp: 1 });
      
    res.json(messages);
  } catch (err) {
    console.error("Error fetching chat:", err);
    res.status(500).json({ error: 'Could not load chat history' });
  }
});

module.exports = router;
