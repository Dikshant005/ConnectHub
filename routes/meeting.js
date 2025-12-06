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

// ---------- PARTICIPANT LEAVE MEETING ----------
router.post('/:id/leave', authMiddleware, async (req, res) => {
  console.log("➡️ LEAVE MEETING API HIT");

  try {
    console.log("📌 Meeting ID:", req.params.id);
    console.log("👤 User:", req.user);

    const meeting = await Meeting.findById(req.params.id);
    if (!meeting) {
      console.log("❌ Meeting not found");
      return res.status(404).json({ error: 'Meeting not found' });
    }

    // Check if user is participant
    const userIdStr = req.user.userId.toString();
    if (!meeting.participants.map(p => p.toString()).includes(userIdStr)) {
      console.log("❌ User not a participant");
      return res.status(400).json({ error: 'Not a participant' });
    }

    // Remove user from participants
    meeting.participants = meeting.participants.filter(p => p.toString() !== userIdStr);
    await meeting.save();

    console.log(`✅ User ${req.user.userId} left meeting ${meeting._id}`);
    console.log(`📊 Remaining participants: ${meeting.participants.length}`);

    // Notify room about user leaving (Socket.IO)
    if (req.io) {
      const roomId = meeting.roomId;
      req.io.to(roomId).emit('user-left', {
        userId: req.user.userId,
        roomId,
        participantsCount: meeting.participants.length
      });
      console.log(`📤 Broadcasted user-left to room ${roomId}`);
    }

    // If last participant and not creator, or creator leaves with no one left
    if (meeting.participants.length === 0 && meeting.creator.toString() === userIdStr) {
      console.log("🗑️ Deleting empty meeting created by leaver");
      await Meeting.deleteOne({ _id: meeting._id });
    }

    res.json({ 
      message: 'Left meeting successfully',
      roomId: meeting.roomId,
      participantsCount: meeting.participants.length
    });

  } catch (err) {
    console.log("💥 Error leaving meeting:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- END MEETING (Creator only) ----------
router.delete('/:id/end', authMiddleware, async (req, res) => {
  console.log("➡️ END MEETING API HIT");

  try {
    console.log("📌 Meeting ID:", req.params.id);
    console.log("👤 User:", req.user);

    const meeting = await Meeting.findById(req.params.id);
    if (!meeting) {
      console.log("❌ Meeting not found");
      return res.status(404).json({ error: 'Meeting not found' });
    }

    if (meeting.creator.toString() !== req.user.userId) {
      console.log("❌ Unauthorized: Not creator");
      return res.status(403).json({ error: 'Only creator can end meeting' });
    }

    console.log("✅ Creator authorized. Ending meeting:", meeting.roomId);

    const roomId = meeting.roomId;

    // Delete meeting
    await Meeting.deleteOne({ _id: meeting._id });

    // Notify all participants
    if (req.io) {
      req.io.to(roomId).emit('meeting-ended', {
        roomId,
        endedBy: req.user.userId,
        message: 'Meeting has been ended by creator'
      });
      console.log(`📤 Broadcasted meeting-ended to room ${roomId}`);
    }

    console.log("🎉 Meeting ended successfully");

    res.json({ 
      message: 'Meeting ended successfully',
      roomId 
    });

  } catch (err) {
    console.log("💥 Error ending meeting:", err.message);
    res.status(500).json({ error: err.message });
  }
});
// Load meet chats
router.get('/:roomId', authMiddleware, async (req, res) => {
  try {
    const { roomId } = req.params;
    
    // Fetch messages sorted by time
    const messages = await Message.find({ meetingId: roomId })
      .sort({ timestamp: 1 }); // Oldest first
      
    res.json(messages);
  } catch (err) {
    console.error("Error fetching chat:", err);
    res.status(500).json({ error: 'Could not load chat history' });
  }
});

module.exports = router;
