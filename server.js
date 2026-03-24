const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');

// Firebase Setup (Realtime Database)
const { initializeApp } = require('firebase/app'); 
const { getDatabase, ref, push, serverTimestamp } = require('firebase/database'); 

// YOUR EXACT FIREBASE KEYS (Only declared once!)
const firebaseConfig = {
  apiKey: "AIzaSyDX45NbE2mSo6NVnh2uvCK0BaBoccGy-ss",
  authDomain: "ipl-auction-game-d1cab.firebaseapp.com",
  databaseURL: "https://ipl-auction-game-d1cab-default-rtdb.asia-southeast1.firebasedatabase.app", // <--- ADD THIS LINE!
  projectId: "ipl-auction-game-d1cab",
  storageBucket: "ipl-auction-game-d1cab.firebasestorage.app",
  messagingSenderId: "178910298039",
  appId: "1:178910298039:web:eb133037094fa7b01b3232",
  measurementId: "G-JDS6N4887N"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp); 

// Server Setup
const app = express();
app.use(cors());
app.use(express.static(__dirname)); 
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const playersData = JSON.parse(fs.readFileSync('./players.json', 'utf8'));
const activeRooms = {};

function calculateTeamRating(squad) {
    if (squad.length === 0) return 0;
    let totalRating = 0;
    let hasWk = false;
    let bowlingOptions = 0;
    squad.forEach(p => {
        totalRating += p.hiddenRating;
        if (p.role === 'Wicketkeeper') hasWk = true;
        if (p.role === 'Bowler' || p.role === 'All-Rounder') bowlingOptions++;
    });
    let finalScore = totalRating / squad.length;
    if (!hasWk) finalScore -= 15; 
    if (bowlingOptions < 5) finalScore -= 10; 
    return Math.round(Math.max(0, Math.min(100, finalScore)));
}

async function finishAuction(roomCode) {
    const room = activeRooms[roomCode];
    if(!room) return;

    let leaderboard = room.users.map(user => {
        return { name: user.name, score: calculateTeamRating(user.squad), squadSize: user.squad.length };
    });

    leaderboard.sort((a, b) => b.score - a.score);
    io.to(roomCode).emit('auctionEnded', leaderboard);

    // Save to Firebase Realtime Database
    try {
        const matchRef = ref(db, 'match_history');
        await push(matchRef, {
            roomCode: roomCode,
            results: leaderboard,
            timestamp: serverTimestamp()
        });
        console.log(`✅ Match ${roomCode} saved to Firebase!`);
    } catch (e) {
        console.error("❌ Error adding document: ", e);
    }
}

function nextPlayer(roomCode) {
    const room = activeRooms[roomCode];
    room.isSelling = false; 
    if (room.availablePlayers.length === 0) { finishAuction(roomCode); return; }
    room.currentPlayer = room.availablePlayers.shift();
    room.currentBid = room.currentPlayer.basePrice;
    room.highestBidder = null;
    io.to(roomCode).emit('newPlayerUp', { player: room.currentPlayer });
    startTimer(roomCode);
}

function startTimer(roomCode) {
    const room = activeRooms[roomCode];
    if (room.timerInterval) clearInterval(room.timerInterval);
    room.timeLeft = 15; 
    io.to(roomCode).emit('timerUpdate', room.timeLeft);
    room.timerInterval = setInterval(() => {
        room.timeLeft--;
        io.to(roomCode).emit('timerUpdate', room.timeLeft);
        if (room.timeLeft <= 0) { clearInterval(room.timerInterval); sellPlayer(roomCode); }
    }, 1000);
}

function sellPlayer(roomCode) {
    const room = activeRooms[roomCode];
    room.isSelling = true; 
    if (room.highestBidder) {
        const winner = room.users.find(u => u.id === room.highestBidder.id);
        if(winner) { winner.purseRemaining -= (room.currentBid / 100); winner.squad.push(room.currentPlayer); }
        io.to(roomCode).emit('playerSold', { winnerName: winner ? winner.name : 'Unknown', amount: room.currentBid, users: room.users });
    } else { io.to(roomCode).emit('playerUnsold'); }
    setTimeout(() => { nextPlayer(roomCode); }, 3500);
}

io.on('connection', (socket) => {
  socket.on('createRoom', (settings) => {
    const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
    const shuffled = [...playersData].sort(() => Math.random() - 0.5);
    activeRooms[roomCode] = { hostId: socket.id, users: [], availablePlayers: shuffled, auctionStarted: false, isSelling: false, settings: settings };
    socket.join(roomCode);
    activeRooms[roomCode].users.push({ id: socket.id, name: 'Host', purseRemaining: settings.startingPurse, squad: [] });
    socket.emit('roomCreated', { code: roomCode, purse: settings.startingPurse });
    io.to(roomCode).emit('updateLobby', activeRooms[roomCode].users);
  });

  socket.on('joinRoom', (roomCode) => {
    roomCode = roomCode.toUpperCase();
    if (activeRooms[roomCode] && !activeRooms[roomCode].auctionStarted) {
      socket.join(roomCode);
      const startMoney = activeRooms[roomCode].settings.startingPurse;
      activeRooms[roomCode].users.push({ id: socket.id, name: `Player ${activeRooms[roomCode].users.length + 1}`, purseRemaining: startMoney, squad: [] });
      socket.emit('roomJoined', { code: roomCode, purse: startMoney });
      io.to(roomCode).emit('updateLobby', activeRooms[roomCode].users);
    }
  });

  socket.on('startAuction', (roomCode) => {
    if (activeRooms[roomCode] && activeRooms[roomCode].hostId === socket.id) {
        activeRooms[roomCode].auctionStarted = true;
        nextPlayer(roomCode);
    }
  });

  socket.on('endAuctionEarly', (roomCode) => {
      if (activeRooms[roomCode] && activeRooms[roomCode].hostId === socket.id) {
          if (activeRooms[roomCode].timerInterval) clearInterval(activeRooms[roomCode].timerInterval);
          finishAuction(roomCode);
      }
  });

  socket.on('placeBid', (roomCode) => {
      const room = activeRooms[roomCode];
      if (!room || !room.auctionStarted || room.isSelling) return;
      const user = room.users.find(u => u.id === socket.id);
      if (room.highestBidder && room.highestBidder.id === socket.id) return;
      let newBid = (room.highestBidder === null) ? room.currentPlayer.basePrice : room.currentBid + 20;
      if ((user.purseRemaining * 100) >= newBid) {
          room.currentBid = newBid; room.highestBidder = user;
          io.to(roomCode).emit('bidUpdated', { bidAmount: room.currentBid, bidderName: user.name });
          startTimer(roomCode);
      }
  });

  socket.on('sendChatMessage', (data) => {
      const room = activeRooms[data.roomCode];
      if (room) {
          const user = room.users.find(u => u.id === socket.id);
          io.to(data.roomCode).emit('receiveChatMessage', { sender: user ? user.name : "Unknown", message: data.message });
      }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 Server on port ${PORT}`); });
