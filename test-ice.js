const { io } = require('socket.io-client');

// ⚙️ CONFIGURATION
const SERVER_URL = 'http://localhost:3000'; // Make sure this matches your server
const ROOM_ID = 'test-room-ice-1';
const USER_A_ID = 'User_A_Sender';
const USER_B_ID = 'User_B_Receiver';

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🧪 STARTING ICE CANDIDATE TEST');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// 1️⃣ CONNECT TWO CLIENTS
const socketA = io(SERVER_URL, { forceNew: true });
const socketB = io(SERVER_URL, { forceNew: true });

// --- USER A LOGIC (The Sender) ---
socketA.on('connect', () => {
    console.log(`🔵 [User A] Connected (ID: ${socketA.id})`);
    socketA.emit('join-room', ROOM_ID, USER_A_ID);
});

// A waits for B to join, then sends the candidate
socketA.on('user-connected', (userId) => {
    if (userId === USER_B_ID) {
        console.log(`🔵 [User A] detected User B.`);
        console.log(`🚀 [User A] Sending ICE Candidate to User B...`);

        const fakeCandidate = {
            candidate: "candidate:12345 1 udp 2122260223 192.168.1.5 5678 typ host",
            sdpMid: "0",
            sdpMLineIndex: 0
        };

        socketA.emit('ice-candidate', {
            toUserId: USER_B_ID,
            fromUserId: USER_A_ID,
            candidate: fakeCandidate
        });
    }
});

// --- USER B LOGIC (The Receiver) ---
socketB.on('connect', () => {
    console.log(`🟢 [User B] Connected (ID: ${socketB.id})`);
    
    // Wait 500ms to ensure A is ready, then join
    setTimeout(() => {
        socketB.emit('join-room', ROOM_ID, USER_B_ID);
    }, 500);
});

// B listens for the candidate
socketB.on('ice-candidate', (data) => {
    console.log('\n✅ TEST PASSED: User B received the candidate!');
    console.log('-------------------------------------------');
    console.log(`📥 From:      ${data.fromUserId}`);
    console.log(`🧊 Candidate: ${data.candidate.candidate}`);
    console.log('-------------------------------------------');
    
    // Success! Close connection
    cleanup();
});

// --- TIMEOUT (If it fails) ---
setTimeout(() => {
    console.error('\n❌ TEST FAILED: Timeout (User B never received data).');
    cleanup();
}, 5000);

function cleanup() {
    socketA.disconnect();
    socketB.disconnect();
    process.exit(0);
}