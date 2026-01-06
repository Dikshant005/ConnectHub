const express = require('express');
const router = express.Router();
const Message = require('../models/message');
const authMiddleware = require('../middleware/authMiddleware');

// GET /chat/:roomId - Fetch chat history for a meeting
router.get('/:roomId', authMiddleware, async (req, res) => {
  try {
    const { roomId } = req.params;
    
    // Fetch messages sorted by time (Oldest first)
    const messages = await Message.find({ meetingId: roomId }).sort({ timestamp: 1 });
      
    res.json(messages);
  } catch (err) {
    console.error("Error fetching chat:", err);
    res.status(500).json({ error: 'Could not load chat history' });
  }
});

// IMPORTANT: This line is likely missing in your file!
module.exports = router;
