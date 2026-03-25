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
        if(winner) { 
            // Math is now directly in Crores
            winner.purseRemaining -= room.currentBid; 
            winner.squad.push(room.currentPlayer); 
        }
        io.to(roomCode).emit('playerSold', { winnerName: winner ? winner.name : 'Unknown', winnerColor: winner ? winner.color : '#fff', amount: room.currentBid, users: room.users });
    } else { io.to(roomCode).emit('playerUnsold'); }
    
    setTimeout(() => { promptHostForNextPlayer(roomCode); }, 3500);
}

function promptHostForNextPlayer(roomCode) {
    const room = activeRooms[roomCode];
    room.isSelling = false; 
    room.bidHistory = [];
    room.currentPlayer = null; 
    
    if (room.availablePlayers.length === 0) { finishAuction(roomCode); return; }
    io.to(roomCode).emit('waitingForNextPlayer', room.availablePlayers);
}

async function finishAuction(roomCode) {
    const room = activeRooms[roomCode];
    if(!room) return;
    
    let leaderboard = room.users.map(user => ({ 
        name: user.name, 
        color: user.color,
        squadSize: user.squad.length,
        purseLeft: parseFloat(user.purseRemaining).toFixed(1) 
    })); 
    
    leaderboard.sort((a, b) => b.squadSize - a.squadSize || b.purseLeft - a.purseLeft);
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
    
    // AUTOMATIC CURRENCY CONVERTER: Converts JSON Lakhs to Crores instantly
    let shuffled = pool.map(p => ({ ...p, basePrice: p.basePrice / 100 })).sort(() => Math.random() - 0.5); 
    
    settings.startingPurse = parseFloat(settings.startingPurse) || 100;
    settings.maxSquad = 15;
    settings.maxOverseas = 4;

    activeRooms[roomCode] = { hostId: socket.id, users: [], availablePlayers: shuffled, auctionStarted: false, isSelling: false, bidHistory: [], settings: settings };
    socket.join(roomCode);
    
    // Push the Host's custom Franchise Name and Color
    activeRooms[roomCode].users.push({ id: socket.id, name: settings.teamName || 'Host', color: settings.teamColor || '#00e5ff', purseRemaining: settings.startingPurse, squad: [] });
    socket.emit('roomCreated', { code: roomCode, purse: settings.startingPurse });
  });

  socket.on('joinRoom', (data) => {
    const roomCode = data.roomCode.toUpperCase();
    if (activeRooms[roomCode]) {
      socket.join(roomCode);
      const startMoney = parseFloat(activeRooms[roomCode].settings.startingPurse) || 100;
      
      // Push the joining player's Franchise Name and Color
      activeRooms[roomCode].users.push({ id: socket.id, name: data.teamName || `Player ${activeRooms[roomCode].users.length + 1}`, color: data.teamColor || '#ff0055', purseRemaining: startMoney, squad: [] });
      socket.emit('roomJoined', { code: roomCode, purse: startMoney, rules: activeRooms[roomCode].settings });
    }
  });

  socket.on('updateRulesAndStart', (data) => {
      const room = activeRooms[data.roomCode];
      if (room && room.hostId === socket.id) {
          room.settings.maxSquad = data.maxSquad;
          room.settings.maxOverseas = data.maxOverseas;
          io.to(data.roomCode).emit('rulesUpdated', room.settings);
          room.auctionStarted = true; 
          promptHostForNextPlayer(data.roomCode);
      }
  });

  socket.on('bringPlayerUp', (data) => {
      const room = activeRooms[data.roomCode];
      if (room && room.hostId === socket.id && !room.currentPlayer) {
          const pIndex = room.availablePlayers.findIndex(p => p.name === data.playerName);
          if (pIndex !== -1) {
              room.currentPlayer = room.availablePlayers.splice(pIndex, 1)[0];
              room.currentBid = room.currentPlayer.basePrice;
              room.highestBidder = null;
              io.to(data.roomCode).emit('newPlayerUp', { player: room.currentPlayer });
              startTimer(data.roomCode, false);
      }
      }
  });

  socket.on('placeBid', (roomCode) => {
      const room = activeRooms[roomCode];
      if (!room || !room.auctionStarted || room.isSelling || room.timerInterval === null || !room.currentPlayer) return;
      const user = room.users.find(u => u.id === socket.id);
      if (room.highestBidder && room.highestBidder.id === socket.id) return;
      
      // NEW BID MATH: Exactly +0.5 Cr increments
      let newBid = (room.highestBidder === null) ? room.currentPlayer.basePrice : room.currentBid + 0.5;
      
      if (user.purseRemaining >= newBid) {
          room.bidHistory.push({ bidder: room.highestBidder, amount: room.currentBid });
          room.currentBid = newBid; room.highestBidder = user;
          io.to(roomCode).emit('bidUpdated', { bidAmount: room.currentBid, bidderName: user.name, bidderColor: user.color });
          startTimer(roomCode, false);
      }
  });

  socket.on('pauseAuction', (roomCode) => {
      const room = activeRooms[roomCode];
      if (room && room.hostId === socket.id && room.currentPlayer) { clearInterval(room.timerInterval); room.timerInterval = null; io.to(roomCode).emit('auctionPaused'); }
  });

  socket.on('resumeAuction', (roomCode) => {
      const room = activeRooms[roomCode];
      if (room && room.hostId === socket.id && room.currentPlayer) { startTimer(roomCode, true); io.to(roomCode).emit('auctionResumed'); }
  });

  socket.on('undoBid', (roomCode) => {
      const room = activeRooms[roomCode];
      if (room && room.hostId === socket.id && room.bidHistory.length > 0 && room.currentPlayer) {
          const prev = room.bidHistory.pop();
          room.currentBid = prev.amount; room.highestBidder = prev.bidder;
          io.to(roomCode).emit('bidUpdated', { 
              bidAmount: room.currentBid, 
              bidderName: room.highestBidder ? room.highestBidder.name : 'None',
              bidderColor: room.highestBidder ? room.highestBidder.color : '#fff'
          });
          startTimer(roomCode, false);
      }
  });

  socket.on('endAuctionEarly', (roomCode) => {
      const room = activeRooms[roomCode];
      if (room && room.hostId === socket.id) {
          if (room.timerInterval) clearInterval(room.timerInterval);
          finishAuction(roomCode);
      }
  });

  socket.on('sendChatMessage', (data) => {
      const room = activeRooms[data.roomCode];
      if (room) {
          const user = room.users.find(u => u.id === socket.id);
          io.to(data.roomCode).emit('receiveChatMessage', { sender: user ? user.name : "Unknown", color: user ? user.color : "#fff", message: data.message });
      }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 Server on port ${PORT}`); });
