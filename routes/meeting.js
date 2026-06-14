const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const Meeting = require("../models/meeting");
const User = require("../models/user");
const Message = require("../models/message");
const authMiddleware = require('../middleware/authMiddleware');
const { uploadToS3 } = require('../utils/s3');
const { AccessToken } = require('livekit-server-sdk');

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: uploadDir });

const getMeetingByIdOrRoomId = async (id) => {
  let meeting = await Meeting.findOne({ roomId: id });
  if (!meeting && mongoose.Types.ObjectId.isValid(id)) {
    meeting = await Meeting.findById(id);
  }
  return meeting;
};

const normalizeReport = (reportText) => {
  if (!reportText) return null;

  const trimmed = String(reportText).trim();
  const unwrapped = trimmed.replace(/^```json\s*/i, '').replace(/```\s*$/i, '');  // removes starting and ending ```json or ```
  return JSON.parse(unwrapped);
};

const buildFallbackReport = (transcript) => {
  const summary = transcript
    ? transcript.split(/(?<=[.!?])\s+/).slice(0, 3).join(' ')  // Split after: .,!,? Take first three sentences and join them
    : '';

  return {
    summary: summary || 'No transcript was available for this meeting.',
    action_items: [],
    promises: [],
    risks: [],
    decisions: [],
  };
};

// Updated to use Gemini
const generateReportFromTranscript = async (transcript, chatHistory, genAI) => {
  if (!genAI) {
    return buildFallbackReport(transcript);
  }

  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `You are a meeting assistant. Extract the following from the transcript and chat history, and return ONLY valid JSON:
        {
          "summary": "2-3 sentence overview",
          "action_items": ["list of tasks mentioned"],
          "promises": ["list of commitments made"],
          "risks": ["list of concerns or blockers mentioned"],
          "decisions": ["list of decisions taken"]
        }

        Transcript:
        ${transcript || 'No transcript was captured.'}

        Chat History:
        ${chatHistory || 'No chat messages were sent.'}`;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    return normalizeReport(text) || buildFallbackReport(transcript);
  } catch (error) {
    console.error("Gemini Error:", error);
    return buildFallbackReport(transcript);
  }
};

const removeMeetingFromActiveSockets = (req, meeting) => {
  const roomUsers = req.roomUsers;
  const roomScreenShares = req.roomScreenShares;

  if (roomUsers?.has(meeting.roomId)) {
    roomUsers.delete(meeting.roomId);
  }

  if (roomScreenShares?.get(meeting.roomId)) {
    roomScreenShares.delete(meeting.roomId);
  }
};

const processMeetingReportInBackground = async (meetingId, genAI, io) => {
  try {
    const meeting = await Meeting.findById(meetingId);
    if (!meeting) return;

    let fullTranscript = '';

    // Sort chunks by index and transcribe each one
    const chunks = (meeting.audioChunks || []).sort((a, b) => a.index - b.index);
    console.log(`📂 [Background] Processing ${chunks.length} audio chunks...`);

    if (chunks.length > 0 && genAI) {
      for (const chunk of chunks) {
        if (chunk.transcript) {
          // ✅ Already transcribed during upload — use it directly
          fullTranscript += (fullTranscript ? '\n' : '') + chunk.transcript;
          console.log(`✅ [Background] Using pre-transcribed chunk ${chunk.index}`);
        } else {
          try {
            console.log(`🎙️ [Background] Transcribing chunk ${chunk.index} (fallback)...`);
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const result = await model.generateContent([
              {
                fileData: {
                  mimeType: "audio/webm",
                  fileUri: chunk.url
                }
              },
              { text: "Please provide a verbatim transcript of this audio segment." },
            ]);
            const chunkTranscript = result.response.text();
            if (chunkTranscript) {
              fullTranscript += (fullTranscript ? '\n' : '') + chunkTranscript;
              console.log(`✅ [Background] Chunk ${chunk.index} transcribed. Length: ${chunkTranscript.length}`);
            }
          } catch (err) {
            console.error(`❌ [Background] Failed to transcribe chunk ${chunk.index}:`, err);
            // Continue with remaining chunks even if one fails
          }
        }
      }
    } else {
      console.warn("⚠️ [Background] No audio chunks found for transcription.");
    }

    // Fetch chat messages
    let chatHistory = '';
    try {
      const messages = await Message.find({ meetingId: meeting.roomId }).sort({ timestamp: 1 });
      chatHistory = messages.map(m => `[${m.senderName}]: ${m.text}`).join('\n');
    } catch (err) {
      console.error("Error fetching chat messages:", err);
    }

    // Generate report from full merged transcript
    const report = await generateReportFromTranscript(fullTranscript, chatHistory, genAI);

    meeting.transcript = fullTranscript;
    meeting.report = report;
    meeting.reportStatus = 'completed';
    await meeting.save();

    console.log(`✅ [Background] Report generated for meeting: ${meeting.roomId}`);

    if (io) {
      io.to(meeting.roomId).emit('report-ready', {
        meetingId: String(meeting._id),
        roomId: meeting.roomId,
        report,
      });
    }

  } catch (err) {
    console.error("❌ [Background] Error processing meeting report:", err);
    try {
      const meeting = await Meeting.findById(meetingId);
      if (meeting) {
        meeting.reportStatus = 'failed';
        await meeting.save();
      }
    } catch (saveErr) {
      console.error("Error updating meeting status to failed:", saveErr);
    }
  }
};

const finalizeMeetingEnd = async (req, res, meetingIdOrRoomId) => {
  const meeting = await getMeetingByIdOrRoomId(meetingIdOrRoomId);

  if (!meeting) {
    return res.status(404).json({ error: 'Meeting not found' });
  }

  if (meeting.creator.toString() !== req.user.userId.toString()) {
    return res.status(403).json({ error: 'Only the host can end this meeting' });
  }

  if (meeting.status === 'ended') {
    return res.json({ success: true, report: meeting.report, message: 'Meeting already ended' });
  }

  meeting.status = 'ended';
  meeting.ended_at = new Date();
  meeting.reportStatus = 'processing';
  await meeting.save();

  removeMeetingFromActiveSockets(req, meeting);

  if (req.io) {
    console.log(`📡 Emitting 'meeting-ended' to room: ${meeting.roomId}`);
    req.io.to(meeting.roomId).emit('meeting-ended', {
      meetingId: String(meeting._id),
      roomId: meeting.roomId,
      status: 'ended',
      reportStatus: 'processing'
    });
  }

  // ✅ No audioFilePath — chunks already uploaded during meeting
  processMeetingReportInBackground(meeting._id, req.genAI, req.io);

  return res.json({
    success: true,
    meetingId: String(meeting._id),
    roomId: meeting.roomId,
    reportStatus: 'processing'
  });
};

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
      host_id: String(req.user.userId),
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

// ---------- CHUNK UPLOAD ----------
router.post('/chunk', authMiddleware, upload.single('audio'), async (req, res) => {
  console.log("➡️ CHUNK UPLOAD API HIT");

  const genAI = req.genAI;

  try {
    const { meetingId, chunkIndex } = req.body;
    if (!meetingId || chunkIndex === undefined || !req.file) {
      return res.status(400).json({ error: 'meetingId, chunkIndex and audio file are required' });
    }

    const meeting = await getMeetingByIdOrRoomId(meetingId);
    if (!meeting) {
      if (req.file?.path) fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Meeting not found' });
    }

    // Upload chunk to S3
    let chunkUrl = '';
    try {
      const fileName = `chunks/${meeting._id}/chunk-${String(chunkIndex).padStart(4, '0')}-${Date.now()}.webm`;
      chunkUrl = await uploadToS3(req.file.path, fileName, 'audio/webm');
      console.log(`✅ Chunk ${chunkIndex} uploaded to S3:`, chunkUrl);
    } catch (err) {
      console.error(`❌ S3 upload failed for chunk ${chunkIndex}:`, err);
      return res.status(500).json({ error: 'Failed to upload chunk to S3' });
    } finally {
      // Clean up local file regardless
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    }

    // Save chunk URL immediately with empty transcript
    if (!meeting.audioChunks) meeting.audioChunks = [];
    meeting.audioChunks.push({
      index: Number(chunkIndex),
      url: chunkUrl,
      transcript: ''
    });
    meeting.markModified('audioChunks');
    await meeting.save();

    // ✅ Respond to frontend immediately — don't wait for transcription
    res.json({ success: true, chunkIndex, chunkUrl });

    // ✅ Transcribe in background — won't block or affect UX at all
    if (genAI) {
      (async () => {
        try {
          console.log(`🎙️ [Background] Transcribing chunk ${chunkIndex}...`);
          const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
          const result = await model.generateContent([
            { fileData: { mimeType: "audio/webm", fileUri: chunkUrl } },
            { text: "Please provide a verbatim transcript of this audio segment." },
          ]);
          const chunkTranscript = result.response.text() || '';
          console.log(`✅ [Background] Chunk ${chunkIndex} transcribed. Length: ${chunkTranscript.length}`);

          // Update the transcript for this specific chunk in DB
          await Meeting.updateOne(
            { _id: meeting._id, 'audioChunks.index': Number(chunkIndex) },
            { $set: { 'audioChunks.$.transcript': chunkTranscript } }
          );
        } catch (err) {
          console.error(`❌ [Background] Transcription failed for chunk ${chunkIndex}:`, err);
          // No action needed — processMeetingReportInBackground will handle empty transcripts
        }
      })();
    }

  } catch (err) {
    console.error("Chunk Upload Error:", err.message);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: err.message });
  }
});

// ---------- END MEETING ----------
router.post('/end', authMiddleware, async (req, res) => {
  console.log("➡️ END MEETING API HIT");
  try {
    const meetingId = req.body.meetingId || req.body.id || req.body.roomId;
    if (!meetingId) {
      return res.status(400).json({ error: 'meetingId is required' });
    }
    return await finalizeMeetingEnd(req, res, meetingId);
  } catch (err) {
    console.error("End Meeting Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/end', authMiddleware, async (req, res) => {
  console.log("➡️ END MEETING API HIT (legacy route)");

  try {
    const { id } = req.params;
    return await finalizeMeetingEnd(req, res, id);

  } catch (err) {
    console.error("End Meeting Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- JOIN MEETING ----------
router.post('/:id/join', authMiddleware, async (req, res) => {
  console.log("➡️ JOIN MEETING API HIT");

  try {
    const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = process.env;

    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
      return res.status(500).json({ error: "LiveKit server credentials not configured on backend." });
    }

    const roomInput = (req.body && (req.body.room || req.body.roomId)) || req.params.id;
    let meeting;

    // Try finding by 6-digit Room ID first, then by Mongo ID
    meeting = await Meeting.findOne({ roomId: roomInput });
    if (!meeting && mongoose.Types.ObjectId.isValid(roomInput)) {
        meeting = await Meeting.findById(roomInput);
    }

    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    const createToken = async (room, identity, name) => {
      const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, name });
      at.addGrant({ roomJoin: true, room });
      return await at.toJwt();
    };

    // If username is missing from req.user, fetch it from DB
    let username = req.user.username;
    if (!username) {
      const user = await User.findById(req.user.userId).select('username');
      username = user ? user.username : 'Anonymous';
    }

    const token = await createToken(meeting.roomId, username, username);

    // Add user to participants list if they are not already there
    if (!meeting.participants.some(p => p.toString() === req.user.userId)) {
      meeting.participants.push(req.user.userId);
      await meeting.save();
      console.log(`🎉 New user joined meeting: ${meeting.roomId}`);
    } else {
      console.log(`🎉 User re-joined meeting: ${meeting.roomId}`);
    }

    const responseData = {
      message: "Successfully joined",
      meeting,
      token,
      livekitUrl: LIVEKIT_URL,
    };

    console.log("DEBUG: Sending this response to frontend:", JSON.stringify(responseData, null, 2));
    res.status(200).json(responseData);

  } catch (err) {
    console.error("Join Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- GET PARTICIPANTS ----------
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

// ---------- PARTICIPANT LEAVE MEETING ----------
router.post('/:id/leave', authMiddleware, async (req, res) => {
  console.log("➡️ LEAVE MEETING API HIT");

  try {
    const { id } = req.params;
    let meeting;

    meeting = await Meeting.findOne({ roomId: id });
    if (!meeting && mongoose.Types.ObjectId.isValid(id)) {
      meeting = await Meeting.findById(id);
    }

    if (!meeting) {
      console.log("⚠️ Meeting not found (already ended). Treating as success.");
      return res.json({ message: 'Meeting already ended' });
    }

    const userIdStr = req.user.userId.toString();
    const isParticipant = meeting.participants.some(p => p.toString() === userIdStr);

    if (!isParticipant) {
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

    res.json({
      message: 'Left meeting successfully',
      roomId: meeting.roomId
    });

  } catch (err) {
    console.error("Leave Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/reports/me', authMiddleware, async (req, res) => {
  try {
    const meetings = await Meeting.find({
      status: 'ended',
      $or: [
        { creator: req.user.userId },
        { participants: req.user.userId },
      ],
    })
      .sort({ ended_at: -1, createdAt: -1 })
      .select('title roomId ended_at report reportStatus creator scheduledAt');

    return res.json({
      meetings: meetings.map((meeting) => ({
        meetingId: String(meeting._id),
        title: meeting.title,
        roomId: meeting.roomId,
        ended_at: meeting.ended_at,
        scheduledAt: meeting.scheduledAt,
        report: meeting.report,
        reportStatus: meeting.reportStatus,
        downloadUrl: `/meetings/${meeting._id}/report/download`,
        reportUrl: `/meetings/${meeting._id}/report`,
      })),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/:meetingId/report', authMiddleware, async (req, res) => {
  try {
    const meeting = await getMeetingByIdOrRoomId(req.params.meetingId);

    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    return res.json({
      meetingId: String(meeting._id),
      roomId: meeting.roomId,
      status: meeting.status,
      reportStatus: meeting.reportStatus,
      ended_at: meeting.ended_at,
      report: meeting.report,
      transcript: meeting.transcript,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/:meetingId/report/download', authMiddleware, async (req, res) => {
  try {
    const meeting = await getMeetingByIdOrRoomId(req.params.meetingId);

    if (!meeting || !meeting.report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const report = meeting.report;
    const doc = new PDFDocument({ margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=report-${meeting._id}.pdf`);
    doc.pipe(res);

    doc.fontSize(20).text('Meeting Report', { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).text('Summary');
    doc.fontSize(12).text(report.summary || 'No summary available.');
    doc.moveDown();
    doc.fontSize(14).text('Action Items');
    (report.action_items || []).forEach(item => doc.fontSize(12).text(`- ${item}`));
    doc.moveDown();
    doc.fontSize(14).text('Promises Made');
    (report.promises || []).forEach(item => doc.fontSize(12).text(`- ${item}`));
    doc.moveDown();
    doc.fontSize(14).text('Risks & Blockers');
    (report.risks || []).forEach(item => doc.fontSize(12).text(`- ${item}`));
    doc.moveDown();
    doc.fontSize(14).text('Decisions');
    (report.decisions || []).forEach(item => doc.fontSize(12).text(`- ${item}`));

    doc.end();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;