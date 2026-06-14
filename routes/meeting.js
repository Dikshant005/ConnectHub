const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const Meeting = require("../models/meeting");
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

    const createToken = (room, identity, name) => {
      const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, name });
      at.addGrant({ roomJoin: true, room });
      return at.toJwt();
    };

    const token = createToken(meeting.roomId, req.user.userId, req.user.username || 'Anonymous');

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

const processMeetingReportInBackground = async (meetingId, audioFilePath, genAI, io) => {  // in future will use live transcription by realtime audio 
  try {
    const meeting = await Meeting.findById(meetingId);
    if (!meeting) return;

    let transcript = '';
    let recordingUrl = '';

    if (audioFilePath && fs.existsSync(audioFilePath)) {
      console.log(`📂 [Background] Found audio file at: ${audioFilePath}, size: ${fs.statSync(audioFilePath).size} bytes`);
      // 1. AWS S3 Upload
      try {
        const fileName = `${Date.now()}-${path.basename(audioFilePath)}`;
        recordingUrl = await uploadToS3(audioFilePath, fileName, 'audio/mpeg');
        console.log("✅ [Background] Uploaded to S3:", recordingUrl);
      } catch (err) {
        console.error("❌ [Background] AWS S3 Upload error:", err);
      }

      // 2. Transcription with Gemini
      if (recordingUrl && genAI) {
        try {
          console.log("🎙️ [Background] Starting transcription with Gemini...");
          const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
          const result = await model.generateContent([
            {
              fileData: {
                mimeType: "audio/mpeg",
                fileUri: recordingUrl
              }
            },
            { text: "Please provide a verbatim transcript of this audio meeting." },
          ]);
          transcript = result.response.text();
          console.log(`✅ [Background] Transcription complete. Length: ${transcript?.length || 0} characters`);
          if (!transcript) {
            console.warn("⚠️ [Background] Gemini returned an empty transcript.");
          }
        } catch (err) {
          console.error("❌ [Background] Gemini transcription error:", err);
        }
      }
    } else {
      console.warn("⚠️ [Background] No audio file found for transcription.");
    }

    // 3. Fetch Chat Messages for the report
    let chatHistory = '';
    try {
      const messages = await Message.find({ meetingId: meeting.roomId }).sort({ timestamp: 1 });
      chatHistory = messages.map(m => `[${m.senderName}]: ${m.text}`).join('\n');
    } catch (err) {
      console.error("Error fetching chat messages for report:", err);
    }

    // 4. Generate Report
    const report = await generateReportFromTranscript(transcript, chatHistory, genAI);

    // Update meeting with final data
    meeting.transcript = transcript;
    meeting.report = report;
    meeting.recordingUrl = recordingUrl;
    meeting.reportStatus = 'completed';
    await meeting.save();

    console.log(`✅ [Background] Report generated for meeting: ${meeting.roomId}`);

    // Emit 'report-ready' to notify the frontend
    if (io) {
      io.to(meeting.roomId).emit('report-ready', {
        meetingId: String(meeting._id),
        roomId: meeting.roomId,
        report,
        recordingUrl,
      });
    }

    // Cleanup local file
    if (audioFilePath && fs.existsSync(audioFilePath)) {
      fs.unlinkSync(audioFilePath);
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
    if (audioFilePath && fs.existsSync(audioFilePath)) {
      fs.unlinkSync(audioFilePath);
    }
  }
};

const finalizeMeetingEnd = async (req, res, meetingIdOrRoomId, audioFilePath) => {
  const meeting = await getMeetingByIdOrRoomId(meetingIdOrRoomId);

  if (!meeting) {
    if (audioFilePath && fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
    return res.status(404).json({ error: 'Meeting not found' });
  }

  if (meeting.creator.toString() !== req.user.userId.toString()) {
    if (audioFilePath && fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
    return res.status(403).json({ error: 'Only the host can end this meeting' });
  }

  if (meeting.status === 'ended') {
    if (audioFilePath && fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
    return res.json({ success: true, report: meeting.report, message: 'Meeting already ended' });
  }

  // Mark meeting as ended IMMEDIATELY
  meeting.status = 'ended';
  meeting.ended_at = new Date();
  meeting.reportStatus = 'processing';
  await meeting.save();

  removeMeetingFromActiveSockets(req, meeting);

  // Emit 'meeting-ended' IMMEDIATELY to notify participants
  if (req.io) {
    console.log(`📡 Emitting 'meeting-ended' to room: ${meeting.roomId}`);
    req.io.to(meeting.roomId).emit('meeting-ended', {
      meetingId: String(meeting._id),
      roomId: meeting.roomId,
      status: 'ended',
      reportStatus: 'processing'
    });
  }

  // Start background processing
  processMeetingReportInBackground(meeting._id, audioFilePath, req.genAI, req.io);

  // Return response IMMEDIATELY (< 1s)
  return res.json({ 
    success: true, 
    meetingId: String(meeting._id), 
    roomId: meeting.roomId, 
    reportStatus: 'processing' 
  });
};

// ---------- END MEETING----------
router.post('/end', authMiddleware, upload.single('audio'), async (req, res) => {
  console.log("➡️ END MEETING API HIT");

  try {
    const meetingId = req.body.meetingId || req.body.id || req.body.roomId;
    if (!meetingId) {
      return res.status(400).json({ error: 'meetingId is required' });
    }

    return await finalizeMeetingEnd(req, res, meetingId, req.file?.path);
  } catch (err) {
    console.error("End Meeting Error:", err.message);
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
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