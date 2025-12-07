const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Meeting = require("../models/meeting");
const authMiddleware = require('../middleware/authMiddleware');

// ---------- CREATE MEETING ----------
router.post('/', authMiddleware, async (req, res) => {
  console.log("➡️ CREATE MEETING API HIT");

  try {
    const { title, scheduledAt } = req.body;

    if (!title || !scheduledAt) {
      return res.status(400).json({ error: 'Title and scheduledAt are required' });
    }

    const generateRoomId = () => Math.floor(100000 + Math.random() * 900000).toString();
    let roomId = generateRoomId();

    while (await Meeting.findOne({ roomId })) {
      roomId = generateRoomId();
    }

    const meeting = new Meeting({
      title,
      scheduledAt,
      creator: req.user.userId,
      participants: [req.user.userId],
      roomId,
    });

    await meeting.save();
    console.log("🎉 Meeting created:", roomId);
    res.status(201).json(meeting);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- JOIN MEETING ----------
router.post('/:id/join', authMiddleware, async (req, res) => {
  console.log("➡️ JOIN MEETING API HIT");
  try {
    const roomInput = req.body.room || req.body.roomId || req.params.id;
    let meeting;

    // 1. Try finding by 6-digit Room ID first
    meeting = await Meeting.findOne({ roomId: roomInput });

    // 2. If not found, check Mongo ID
    if (!meeting && mongoose.Types.ObjectId.isValid(roomInput)) {
      meeting = await Meeting.findById(roomInput);
    }

    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    if (meeting.participants.includes(req.user.userId)) {
      return res.status(400).json({ error: 'Already joined' });
    }

    meeting.participants.push(req.user.userId);
    await meeting.save();

    console.log(`🎉 User joined meeting: ${meeting.roomId}`);
    res.json({ message: 'Joined meeting', meeting });

  } catch (err) {
    console.error("Join Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- PARTICIPANT LEAVE MEETING (FIXED) ----------
router.post('/:id/leave', authMiddleware, async (req, res) => {
  console.log("➡️ LEAVE MEETING API HIT");

  try {
    const { id } = req.params; 
    let meeting;

    meeting = await Meeting.findOne({ roomId: id });
    if (!meeting && mongoose.Types.ObjectId.isValid(id)) {
      meeting = await Meeting.findById(id);
    }

    // ✅ CRITICAL FIX 1: If meeting is missing, it was likely ended by host. 
    // Return SUCCESS (not 404) so the app doesn't show an error.
    if (!meeting) {
      console.log("⚠️ Meeting not found (already ended). Treating as success.");
      return res.json({ message: 'Meeting already ended' }); 
    }

    const userIdStr = req.user.userId.toString();
    const isParticipant = meeting.participants.some(p => p.toString() === userIdStr);

    if (!isParticipant) {
      // Just return success to keep UI clean
      return res.json({ message: 'User was not in meeting' });
    }

    meeting.participants = meeting.participants.filter(p => p.toString() !== userIdStr);
    await meeting.save();

    console.log(`✅ User left meeting ${meeting.roomId}`);

    if (req.io) {
      req.io.to(meeting.roomId).emit('user-left', {
        userId: req.user.userId,
        roomId: meeting.roomId,
        participantsCount: meeting.participants.length
      });
    }

    if (meeting.participants.length === 0 && meeting.creator.toString() === userIdStr) {
      console.log("🗑️ Deleting empty meeting");
      await Meeting.deleteOne({ _id: meeting._id });
    }

    res.json({
      message: 'Left meeting successfully',
      roomId: meeting.roomId
    });

  } catch (err) {
    console.error("Leave Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- END MEETING (FIXED) ----------
router.delete('/:id/end', authMiddleware, async (req, res) => {
  console.log("➡️ END MEETING API HIT");

  try {
    const { id } = req.params;
    let meeting;

    meeting = await Meeting.findOne({ roomId: id });
    if (!meeting && mongoose.Types.ObjectId.isValid(id)) {
      meeting = await Meeting.findById(id);
    }

    if (!meeting) {
      // If it's already gone, just return success
      return res.json({ message: 'Meeting already ended' });
    }

    if (meeting.creator.toString() !== req.user.userId) {
      return res.status(403).json({ error: 'Only creator can end meeting' });
    }

    const roomId = meeting.roomId;
    const mongoId = meeting._id.toString(); // ✅ Capture Mongo ID before deleting

    // Delete
    await Meeting.deleteOne({ _id: meeting._id });

    // ✅ CRITICAL FIX 2: Broadcast to BOTH rooms to ensure everyone hears it
    if (req.io) {
      // 1. Notify 6-digit room
      req.io.to(roomId).emit('meeting-ended', {
        roomId,
        endedBy: req.user.userId,
        message: 'Meeting has been ended by creator'
      });

      // 2. Notify Mongo ID room (Backup for mismatched users)
      req.io.to(mongoId).emit('meeting-ended', {
        roomId,
        endedBy: req.user.userId,
        message: 'Meeting has been ended by creator'
      });
      
      console.log(`📤 Broadcasted END to ${roomId} AND ${mongoId}`);
    }

    console.log(`🛑 Meeting ${roomId} ended by creator`);
    res.json({ message: 'Meeting ended successfully', roomId });

  } catch (err) {
    console.error("End Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;