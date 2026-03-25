const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const { initializeApp } = require('firebase/app'); 
const { getDatabase, ref, push, serverTimestamp } = require('firebase/database'); 

const firebaseConfig = {
  apiKey: "AIzaSyDX45NbE2mSo6NVnh2uvCK0BaBoccGy-ss",
  authDomain: "ipl-auction-game-d1cab.firebaseapp.com",
  databaseURL: "https://ipl-auction-game-d1cab-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "ipl-auction-game-d1cab",
  storageBucket: "ipl-auction-game-d1cab.firebasestorage.app",
  messagingSenderId: "178910298039",
  appId: "1:178910298039:web:eb133037094fa7b01b3232",
  measurementId: "G-JDS6N4887N"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp); 

const app = express();
app.use(cors());
app.use(express.static(__dirname)); 
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const playersData = JSON.parse(fs.readFileSync('./players.json', 'utf8'));
const activeRooms = {};

function startTimer(roomCode, isResume = false) {
    const room = activeRooms[roomCode];
    if (room.timerInterval) clearInterval(room.timerInterval);
    if (!isResume) room.timeLeft = 15; 
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

function nextPlayer(roomCode) {
    const room = activeRooms[roomCode];
    room.isSelling = false; room.bidHistory = [];
    if (room.availablePlayers.length === 0) { finishAuction(roomCode); return; }
    room.currentPlayer = room.availablePlayers.shift();
    room.currentBid = room.currentPlayer.basePrice;
    room.highestBidder = null;
    io.to(roomCode).emit('newPlayerUp', { player: room.currentPlayer });
    startTimer(roomCode, false);
}

async function finishAuction(roomCode) {
    const room = activeRooms[roomCode];
    let leaderboard = room.users.map(user => ({ name: user.name, score: 85, squadSize: user.squad.length })); 
    leaderboard.sort((a, b) => b.score - a.score);
    io.to(roomCode).emit('auctionEnded', leaderboard);
    try {
        const matchRef = ref(db, 'match_history');
        await push(matchRef, { roomCode, results: leaderboard, timestamp: serverTimestamp() });
    } catch (e) { console.error(e); }
}

io.on('connection', (socket) => {
  socket.on('createRoom', (settings) => {
    const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
    let pool = playersData.filter(p => p.formats && p.formats.includes(settings.format));
    let shuffled = pool.sort(() => Math.random() - 0.5).slice(0, 80);
    
    activeRooms[roomCode] = { hostId: socket.id, users: [], availablePlayers: shuffled, auctionStarted: false, isSelling: false, bidHistory: [], settings: settings };
    socket.join(roomCode);
    activeRooms[roomCode].users.push({ id: socket.id, name: 'Host', purseRemaining: settings.startingPurse, squad: [] });
    socket.emit('roomCreated', { code: roomCode, purse: settings.startingPurse, format: settings.format, poolSize: shuffled.length });
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
        activeRooms[roomCode].auctionStarted = true; nextPlayer(roomCode);
    }
  });

  socket.on('placeBid', (roomCode) => {
      const room = activeRooms[roomCode];
      if (!room || !room.auctionStarted || room.isSelling || room.timerInterval === null) return;
      const user = room.users.find(u => u.id === socket.id);
      if (room.highestBidder && room.highestBidder.id === socket.id) return;
      let newBid = (room.highestBidder === null) ? room.currentPlayer.basePrice : room.currentBid + 20;
      if ((user.purseRemaining * 100) >= newBid) {
          room.bidHistory.push({ bidder: room.highestBidder, amount: room.currentBid });
          room.currentBid = newBid; room.highestBidder = user;
          io.to(roomCode).emit('bidUpdated', { bidAmount: room.currentBid, bidderName: user.name });
          startTimer(roomCode, false);
      }
  });

  socket.on('pauseAuction', (roomCode) => {
      const room = activeRooms[roomCode];
      if (room && room.hostId === socket.id) { clearInterval(room.timerInterval); room.timerInterval = null; io.to(roomCode).emit('auctionPaused'); }
  });

  socket.on('resumeAuction', (roomCode) => {
      const room = activeRooms[roomCode];
      if (room && room.hostId === socket.id) { startTimer(roomCode, true); io.to(roomCode).emit('auctionResumed'); }
  });

  socket.on('undoBid', (roomCode) => {
      const room = activeRooms[roomCode];
      if (room && room.hostId === socket.id && room.bidHistory.length > 0) {
          const prev = room.bidHistory.pop();
          room.currentBid = prev.amount; room.highestBidder = prev.bidder;
          io.to(roomCode).emit('bidUpdated', { bidAmount: room.currentBid, bidderName: room.highestBidder ? room.highestBidder.name : 'None' });
          startTimer(roomCode, false);
      }
  });

  // CHAT SERVER LOGIC
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
