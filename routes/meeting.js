const express = require('express');
const router = express.Router();
const mongoose = require('mongoose'); // <--- Added this to validate IDs
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
    // 1. Determine what ID we are working with
    const roomInput = req.body.room || req.body.roomId || req.params.id;
    let meeting;

    // 2. Try finding by 6-digit Room ID first
    meeting = await Meeting.findOne({ roomId: roomInput });

    // 3. If not found, and it looks like a Mongo ID, try finding by _id
    if (!meeting && mongoose.Types.ObjectId.isValid(roomInput)) {
      meeting = await Meeting.findById(roomInput);
    }

    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    // 4. Check logic
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

// ---------- PARTICIPANT LEAVE MEETING (UPDATED) ----------
router.post('/:id/leave', authMiddleware, async (req, res) => {
  console.log("➡️ LEAVE MEETING API HIT");

  try {
    const { id } = req.params; // Can be roomId OR _id
    let meeting;

    // 1. Try finding by 6-digit Room ID first
    meeting = await Meeting.findOne({ roomId: id });

    // 2. If not found, check if it's a valid Mongo Object ID
    if (!meeting && mongoose.Types.ObjectId.isValid(id)) {
      meeting = await Meeting.findById(id);
    }

    if (!meeting) {
      console.log("❌ Meeting not found with ID:", id);
      return res.status(404).json({ error: 'Meeting not found' });
    }

    // 3. Check if user is participant
    const userIdStr = req.user.userId.toString();
    const isParticipant = meeting.participants.some(p => p.toString() === userIdStr);

    if (!isParticipant) {
      return res.status(400).json({ error: 'Not a participant' });
    }

    // 4. Remove user
    meeting.participants = meeting.participants.filter(p => p.toString() !== userIdStr);
    await meeting.save();

    console.log(`✅ User left meeting ${meeting.roomId}`);

    // 5. Notify Socket Room
    if (req.io) {
      req.io.to(meeting.roomId).emit('user-left', {
        userId: req.user.userId,
        roomId: meeting.roomId,
        participantsCount: meeting.participants.length
      });
    }

    // 6. Delete if empty (and creator left)
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

// ---------- END MEETING (Creator only) (UPDATED) ----------
router.delete('/:id/end', authMiddleware, async (req, res) => {
  console.log("➡️ END MEETING API HIT");

  try {
    const { id } = req.params; // Can be roomId OR _id
    let meeting;

    // 1. Search by Room ID
    meeting = await Meeting.findOne({ roomId: id });

    // 2. Search by Mongo ID
    if (!meeting && mongoose.Types.ObjectId.isValid(id)) {
      meeting = await Meeting.findById(id);
    }

    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    // 3. Check Creator
    if (meeting.creator.toString() !== req.user.userId) {
      return res.status(403).json({ error: 'Only creator can end meeting' });
    }

    const roomId = meeting.roomId;

    // 4. Delete
    await Meeting.deleteOne({ _id: meeting._id });

    // 5. Notify Socket
    if (req.io) {
      req.io.to(roomId).emit('meeting-ended', {
        roomId,
        endedBy: req.user.userId,
        message: 'Meeting has been ended by creator'
      });
    }

    console.log(`🛑 Meeting ${roomId} ended by creator`);
    res.json({ message: 'Meeting ended successfully', roomId });

  } catch (err) {
    console.error("End Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;