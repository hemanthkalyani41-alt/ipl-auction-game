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
    if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
    if (!isResume) room.timeLeft = 15; 
    
    io.to(roomCode).emit('timerUpdate', room.timeLeft);
    
    room.timerInterval = setInterval(() => {
        room.timeLeft--;
        io.to(roomCode).emit('timerUpdate', room.timeLeft);
        if (room.timeLeft <= 0) { 
            clearInterval(room.timerInterval); 
            room.timerInterval = null;
            if(!room.isSelling && !room.tradePhase) sellPlayer(roomCode); 
        }
    }, 1000);
}

function sellPlayer(roomCode) {
    const room = activeRooms[roomCode];
    if(!room || room.tradePhase) return; // Ghost lock
    
    room.isSelling = true; 
    room.bidTimestamps = []; 
    if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }

    if (room.highestBidder) {
        const winner = room.users.find(u => u.id === room.highestBidder.id);
        if(winner) { 
            winner.purseRemaining -= room.currentBid; 
            winner.squad.push({ ...room.currentPlayer, soldPrice: room.currentBid }); 
        }
        io.to(roomCode).emit('playerSold', { winnerName: winner ? winner.name : 'Unknown', winnerColor: winner ? winner.color : '#fff', amount: room.currentBid, users: room.users });
    } else { 
        io.to(roomCode).emit('playerUnsold'); 
    }
    
    setTimeout(() => { promptHostForNextPlayer(roomCode); }, 3500);
}

function promptHostForNextPlayer(roomCode) {
    const room = activeRooms[roomCode];
    // THE ULTIMATE FIX: If the game ended during the 3.5s wait, kill this function immediately!
    if(!room || room.tradePhase) return; 
    
    room.isSelling = false; 
    room.bidHistory = [];
    room.currentPlayer = null; 
    
    if (room.availablePlayers.length === 0) { startTradePhase(roomCode); return; }
    io.to(roomCode).emit('waitingForNextPlayer', room.availablePlayers);
}

function startTradePhase(roomCode) {
    const room = activeRooms[roomCode];
    if(!room) return;
    if(room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
    room.auctionStarted = false;
    room.tradePhase = true;
    room.isSelling = false; // Unlock anything stuck
    io.to(roomCode).emit('tradePhaseStarted', room.users);
}

function calculateAIRating(squad) {
    if(squad.length === 0) return "0.0";
    let avg = squad.reduce((sum, p) => sum + (p.hiddenRating || 85), 0) / squad.length;
    let score = avg / 10; 
    
    let roles = { 'Batsman':0, 'Bowler':0, 'All-Rounder':0, 'Wicketkeeper':0, 'Captain':0 };
    squad.forEach(p => { 
        let r = p.role;
        if(["MS Dhoni", "Rohit Sharma", "Pat Cummins", "Shreyas Iyer", "Sanju Samson", "Ruturaj Gaikwad", "KL Rahul", "Shubman Gill", "Kane Williamson", "Babar Azam", "Virat Kohli"].includes(p.name)) {
            r = 'Captain';
        }
        roles[r] = (roles[r] || 0) + 1; 
    });
    
    if(roles['Wicketkeeper'] === 0) score -= 1.5;
    if(roles['Bowler'] < 3) score -= 1.0;
    if(roles['Batsman'] < 3) score -= 1.0;
    if(roles['Captain'] === 0) score -= 0.5;
    if(squad.length < 11) score -= 1.5;
    
    return Math.max(1.0, Math.min(10.0, score)).toFixed(1);
}

async function finishGame(roomCode) {
    const room = activeRooms[roomCode];
    if(!room) return;
    
    let leaderboard = room.users.map(user => ({ 
        name: user.name, 
        color: user.color,
        squadSize: user.squad.length,
        purseLeft: parseFloat(user.purseRemaining).toFixed(1),
        squad: user.squad,
        aiRating: calculateAIRating(user.squad)
    })); 
    
    leaderboard.sort((a, b) => b.aiRating - a.aiRating || b.squadSize - a.squadSize);
    io.to(roomCode).emit('gameEnded', leaderboard);
    
    try {
        const matchRef = ref(db, 'match_history');
        await push(matchRef, { roomCode, results: leaderboard, timestamp: serverTimestamp() });
    } catch (e) { console.error(e); }
}

io.on('connection', (socket) => {
  socket.on('createRoom', (settings) => {
    const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
    let pool = (settings.format === 'All') ? playersData : playersData.filter(p => p.formats && p.formats.includes(settings.format));
    let shuffled = pool.map(p => ({ ...p, basePrice: p.basePrice / 100 })).sort(() => Math.random() - 0.5); 
    
    settings.startingPurse = parseFloat(settings.startingPurse) || 100;
    settings.maxSquad = 15;
    settings.maxOverseas = 4;

    activeRooms[roomCode] = { hostId: socket.id, users: [], availablePlayers: shuffled, auctionStarted: false, isSelling: false, tradePhase: false, bidHistory: [], bidTimestamps: [], settings: settings };
    socket.join(roomCode);
    activeRooms[roomCode].users.push({ id: socket.id, name: settings.teamName || 'Host', color: settings.teamColor || '#00e5ff', purseRemaining: settings.startingPurse, squad: [] });
    socket.emit('roomCreated', { code: roomCode, purse: settings.startingPurse });
  });

  socket.on('joinRoom', (data) => {
    const roomCode = data.roomCode.toUpperCase();
    if (activeRooms[roomCode]) {
      socket.join(roomCode);
      const startMoney = parseFloat(activeRooms[roomCode].settings.startingPurse) || 100;
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
      if (room && room.hostId === socket.id && !room.currentPlayer && !room.isSelling && !room.tradePhase) {
          const pIndex = room.availablePlayers.findIndex(p => p.name === data.playerName);
          if (pIndex !== -1) {
              room.currentPlayer = room.availablePlayers.splice(pIndex, 1)[0];
              room.currentBid = room.currentPlayer.basePrice;
              room.highestBidder = null;
              room.bidTimestamps = []; 
              io.to(data.roomCode).emit('newPlayerUp', { player: room.currentPlayer });
              startTimer(data.roomCode, false);
          }
      }
  });

  socket.on('placeBid', (roomCode) => {
      const room = activeRooms[roomCode];
      if (!room || !room.auctionStarted || room.isSelling || room.timerInterval === null || !room.currentPlayer || room.tradePhase) return;
      const user = room.users.find(u => u.id === socket.id);
      if (room.highestBidder && room.highestBidder.id === socket.id) return;
      
      let now = Date.now();
      room.bidTimestamps.push(now);
      if(room.bidTimestamps.length > 3) room.bidTimestamps.shift();
      
      let isHypeMode = false;
      if(room.bidTimestamps.length === 3 && (now - room.bidTimestamps[0] <= 3000)) {
          isHypeMode = true;
      }

      let newBid = (room.highestBidder === null) ? room.currentPlayer.basePrice : room.currentBid + (isHypeMode ? 1.0 : 0.5);
      
      if (user.purseRemaining >= newBid) {
          room.bidHistory.push({ bidder: room.highestBidder, amount: room.currentBid });
          room.currentBid = newBid; room.highestBidder = user;
          io.to(roomCode).emit('bidUpdated', { bidAmount: room.currentBid, bidderName: user.name, bidderColor: user.color, hypeMode: isHypeMode });
          startTimer(roomCode, false);
      }
  });

  socket.on('pauseAuction', (roomCode) => {
      const room = activeRooms[roomCode];
      if (room && room.hostId === socket.id && room.currentPlayer && !room.isSelling && !room.tradePhase) { 
          clearInterval(room.timerInterval); room.timerInterval = null; io.to(roomCode).emit('auctionPaused'); 
      }
  });

  socket.on('resumeAuction', (roomCode) => {
      const room = activeRooms[roomCode];
      if (room && room.hostId === socket.id && room.currentPlayer && !room.isSelling && !room.tradePhase) { 
          startTimer(roomCode, true); io.to(roomCode).emit('auctionResumed'); 
      }
  });

  socket.on('undoBid', (roomCode) => {
      const room = activeRooms[roomCode];
      if (room && room.hostId === socket.id && room.bidHistory.length > 0 && room.currentPlayer && !room.isSelling && !room.tradePhase) {
          const prev = room.bidHistory.pop();
          room.currentBid = prev.amount; room.highestBidder = prev.bidder;
          room.bidTimestamps = []; 
          io.to(roomCode).emit('bidUpdated', { 
              bidAmount: room.currentBid, 
              bidderName: room.highestBidder ? room.highestBidder.name : 'None',
              bidderColor: room.highestBidder ? room.highestBidder.color : '#fff',
              hypeMode: false
          });
          startTimer(roomCode, false);
      }
  });

  socket.on('endAuctionEarly', (roomCode) => {
      const room = activeRooms[roomCode];
      if (room && room.hostId === socket.id && !room.tradePhase) {
          if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
          startTradePhase(roomCode);
      }
  });

  socket.on('executeTrade', (data) => {
      const room = activeRooms[data.roomCode];
      if (room && room.hostId === socket.id && room.tradePhase) {
          const t1 = room.users.find(u => u.name === data.team1);
          const t2 = room.users.find(u => u.name === data.team2);
          if(t1 && t2) {
              const p1Index = t1.squad.findIndex(p => p.name === data.player1);
              const p2Index = t2.squad.findIndex(p => p.name === data.player2);
              
              let p1 = p1Index !== -1 ? t1.squad.splice(p1Index, 1)[0] : null;
              let p2 = p2Index !== -1 ? t2.squad.splice(p2Index, 1)[0] : null;
              
              if(p1) t2.squad.push(p1);
              if(p2) t1.squad.push(p2);
              
              io.to(data.roomCode).emit('tradePhaseStarted', room.users); 
          }
      }
  });

  socket.on('finalizeGame', (roomCode) => {
      const room = activeRooms[roomCode];
      if (room && room.hostId === socket.id && room.tradePhase) {
          finishGame(roomCode);
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
