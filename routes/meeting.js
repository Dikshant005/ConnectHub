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

// ---------- JOIN MEETING (FIXED WITH SOCKET) ----------
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

    // ✅ FIX: Check database count before adding!
    // If user is NOT already in the list AND list size is >= 2, reject them.
    if (!meeting.participants.includes(req.user.userId) && meeting.participants.length >= 2) {
      console.log(`⛔ Blocked user ${req.user.userId} from joining full room ${meeting.roomId}`);
      return res.status(403).json({ message: 'Meeting is full (Max 2 people)' });
    }

    // 3. Check if already joined (Idempotency)
    if (meeting.participants.includes(req.user.userId)) {
      // It's okay to return 200 here so the frontend proceeds to the meeting page
      return res.status(200).json({ message: 'Already joined', meeting });
    }

    // 4. Add user to DB
    meeting.participants.push(req.user.userId);
    await meeting.save();

    // ✅ CRITICAL ADDITION: Notify room that someone joined
    if (req.io) {
      req.io.to(meeting.roomId).emit('user-joined', {
        userId: req.user.userId,
        roomId: meeting.roomId,
        participantsCount: meeting.participants.length
      });
      console.log(`📡 Emitted user-joined to room ${meeting.roomId}`);
    }

    console.log(`🎉 User joined meeting: ${meeting.roomId}`);
    res.json({ message: 'Joined meeting', meeting });

  } catch (err) {
    console.error("Join Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- GET PARTICIPANTS ----------
// Allows frontend to fetch all participants in a meeting by roomId or mongoId
router.get('/:id/participants', authMiddleware, async (req, res) => {
  console.log("➡️ GET PARTICIPANTS API HIT");

  try {
    const { id } = req.params;
    let meeting;

    // try roomId first
    meeting = await Meeting.findOne({ roomId: id }).populate('participants', 'username email');

    // fallback to Mongo ObjectId
    if (!meeting && mongoose.Types.ObjectId.isValid(id)) {
      meeting = await Meeting.findById(id).populate('participants', 'username email');
    }

    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    return res.json({
      roomId: meeting.roomId,
      meetingId: meeting._id,
      participants: meeting.participants,
      participantsCount: meeting.participants.length,
    });
  } catch (err) {
    console.error('Participants Error:', err.message);
    return res.status(500).json({ error: err.message });
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