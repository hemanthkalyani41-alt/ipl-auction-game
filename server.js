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

let playersData = [];
try {
    playersData = JSON.parse(fs.readFileSync('./players.json', 'utf8'));
} catch (err) {
    console.error("FATAL ERROR: players.json missing or broken.", err);
}

const activeRooms = {};
const captainList = ["MS Dhoni", "Rohit Sharma", "Pat Cummins", "Shreyas Iyer", "Sanju Samson", "Ruturaj Gaikwad", "KL Rahul", "Shubman Gill", "Kane Williamson", "Babar Azam", "Virat Kohli", "Faf du Plessis"];

// SERVER MEMORY PROTECTION: Clean up dead rooms every 6 hours
setInterval(() => {
    const now = Date.now();
    for (let code in activeRooms) {
        if (activeRooms[code].createdAt && (now - activeRooms[code].createdAt > 6 * 60 * 60 * 1000)) {
            if (activeRooms[code].timerInterval) clearInterval(activeRooms[code].timerInterval);
            delete activeRooms[code];
        }
    }
}, 1000 * 60 * 60);

function startTimer(roomCode, isResume = false) {
    const room = activeRooms[roomCode];
    if (!room) return;
    if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
    if (!isResume) room.timeLeft = 15; 
    
    io.to(roomCode).emit('timerUpdate', room.timeLeft);
    
    room.timerInterval = setInterval(() => {
        room.timeLeft--;
        io.to(roomCode).emit('timerUpdate', room.timeLeft);
        if (room.timeLeft <= 0) { 
            clearInterval(room.timerInterval); 
            room.timerInterval = null;
            if(room && !room.isSelling && !room.tradePhase && !room.build11Phase && room.currentPlayer) {
                sellPlayer(roomCode); 
            }
        }
    }, 1000);
}

function sellPlayer(roomCode) {
    const room = activeRooms[roomCode];
    if(!room || room.tradePhase || room.build11Phase || !room.currentPlayer) return; 
    
    room.isSelling = true; 
    room.bidTimestamps = []; 
    if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }

    try {
        if (room.highestBidder) {
            const winner = room.users.find(u => u.id === room.highestBidder.id);
            if(winner) { 
                winner.purseRemaining -= room.currentBid; 
                const soldPlayer = {
                    name: room.currentPlayer.name, role: room.currentPlayer.role,
                    country: room.currentPlayer.country, basePrice: room.currentPlayer.basePrice,
                    hiddenRating: room.currentPlayer.hiddenRating, jerseyNumber: room.currentPlayer.jerseyNumber,
                    soldPrice: room.currentBid
                };
                winner.squad.push(soldPlayer); 
            }
            io.to(roomCode).emit('playerSold', { winnerName: winner ? winner.name : 'Unknown', winnerColor: winner ? winner.color : '#fff', amount: room.currentBid, users: room.users });
        } else { 
            io.to(roomCode).emit('playerUnsold'); 
        }
    } catch (err) {
        console.error("Sell Player Error:", err);
    }
    
    setTimeout(() => { promptHostForNextPlayer(roomCode); }, 3500);
}

function promptHostForNextPlayer(roomCode) {
    try {
        const room = activeRooms[roomCode];
        if(!room || room.tradePhase || room.build11Phase) return; 
        
        room.isSelling = false; 
        room.bidHistory = [];
        room.currentPlayer = null; 
        
        if (room.availablePlayers.length === 0) { startTradePhase(roomCode); return; }
        io.to(roomCode).emit('waitingForNextPlayer', room.availablePlayers);
    } catch (err) {
        console.error(err);
    }
}

function startTradePhase(roomCode) {
    const room = activeRooms[roomCode];
    if(!room) return;
    if(room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
    room.auctionStarted = false;
    room.tradePhase = true;
    room.isSelling = false; 
    room.currentPlayer = null; 
    io.to(roomCode).emit('tradePhaseStarted', room.users);
}

function startBuild11Phase(roomCode) {
    const room = activeRooms[roomCode];
    if(!room) return;
    room.tradePhase = false;
    room.build11Phase = true;
    io.to(roomCode).emit('build11PhaseStarted', room.users);
}

// UPGRADED DYNAMIC FORMAT & COMBINATION AI ENGINE WITH EXPLANATIONS
function calculateAIRating(playingXI, format) {
    if(!playingXI || playingXI.length === 0) return { score: "0.0", reasons: ["❌ No players selected."] };
    
    let avg = playingXI.reduce((sum, p) => sum + (p.hiddenRating || 85), 0) / playingXI.length;
    let score = avg / 10; 
    let reasons = [];
    
    let roles = { 'Opener':0, 'Middle Order':0, 'Pacer':0, 'Spinner':0, 'All-Rounder':0, 'Wicketkeeper':0, 'Captain':0 };
    let overseas = 0;

    playingXI.forEach(p => { 
        let r = p.role;
        if(p.name && captainList.includes(p.name)) r = 'Captain';
        roles[r] = (roles[r] || 0) + 1; 
        
        if(r === 'Captain') {
            if(["Rohit Sharma", "Shubman Gill", "KL Rahul", "Babar Azam", "Faf du Plessis"].includes(p.name)) roles['Opener']++;
            if(["Virat Kohli", "Shreyas Iyer", "Kane Williamson", "AB de Villiers", "Suryakumar Yadav"].includes(p.name)) roles['Middle Order']++;
            if(["Pat Cummins"].includes(p.name)) roles['Pacer']++;
            if(["MS Dhoni", "Sanju Samson", "Rishabh Pant"].includes(p.name)) roles['Wicketkeeper']++;
        }
        if(p.country !== 'India') overseas++;
    });
    
    // --- SYNERGY BONUSES ---
    if (roles['Opener'] >= 2) { score += 0.3; reasons.push("✅ Strong Opening Pair (+0.3)"); }
    if (roles['All-Rounder'] >= 2) { score += 0.4; reasons.push("✅ Excellent All-Round Depth (+0.4)"); }
    if (roles['Pacer'] >= 2 && roles['Spinner'] >= 1) { score += 0.5; reasons.push("✅ Balanced Pace/Spin Attack (+0.5)"); }

    // --- UNIVERSAL PENALTIES ---
    if(roles['Wicketkeeper'] === 0) { score -= 1.5; reasons.push("❌ Missing Wicketkeeper (-1.5)"); }
    if(roles['Opener'] < 2) { score -= 1.0; reasons.push("❌ Lacks Opening Batsmen (-1.0)"); }
    if(roles['Captain'] === 0) { score -= 0.5; reasons.push("❌ No Captain Assigned (-0.5)"); }
    if(overseas > 4) { score -= 2.0; reasons.push("❌ Exceeded Overseas Limit (-2.0)"); }
    if(playingXI.length < 11) { 
        let pen = (11 - playingXI.length) * 0.5;
        score -= pen; 
        reasons.push(`❌ Incomplete XI Penalty (-${pen.toFixed(1)})`); 
    }
    
    let bowlingOptions = roles['Pacer'] + roles['Spinner'] + roles['All-Rounder'];

    // --- FORMAT-SPECIFIC LOGIC ---
    if (format === 'T20') {
        if(roles['All-Rounder'] < 2) { score -= 1.0; reasons.push("❌ T20: Lacks All-Rounders (-1.0)"); }
        if(bowlingOptions < 5) { score -= 1.5; reasons.push("❌ T20: Insufficient Bowling Options (-1.5)"); }
    } else if (format === 'Test') {
        if(roles['Middle Order'] < 4) { score -= 1.0; reasons.push("❌ Test: Fragile Middle Order (-1.0)"); }
        if(roles['Spinner'] < 1) { score -= 1.5; reasons.push("❌ Test: Missing Specialist Spinner (-1.5)"); }
        if(bowlingOptions < 4) { score -= 1.5; reasons.push("❌ Test: Weak Bowling Attack (-1.5)"); }
    } else { 
        if(roles['Middle Order'] < 3) { score -= 0.5; reasons.push("❌ ODI: Weak Middle Order (-0.5)"); }
        if(roles['Pacer'] < 2) { score -= 1.0; reasons.push("❌ ODI: Lacks Pace Attack (-1.0)"); }
        if(roles['Spinner'] === 0) { score -= 1.0; reasons.push("❌ ODI: Lacks Spin Attack (-1.0)"); }
        if(bowlingOptions < 5) { score -= 1.5; reasons.push("❌ ODI: Insufficient Bowling Options (-1.5)"); }
    }
    
    if(reasons.filter(r => r.includes("❌")).length === 0) reasons.push("🌟 Flawless Team Composition!");

    return { score: Math.max(1.0, Math.min(10.0, score)).toFixed(1), reasons: reasons };
}

async function finishGame(roomCode) {
    const room = activeRooms[roomCode];
    if(!room) return;
    
    room.users.forEach(user => {
        if(!user.playing11 || user.playing11.length === 0) {
            let sortedSquad = [...user.squad].sort((a,b) => b.hiddenRating - a.hiddenRating);
            user.playing11 = sortedSquad.slice(0, 11);
        }
    });

    let leaderboard = room.users.map(user => {
        let aiEvaluation = calculateAIRating(user.playing11, room.settings.format);
        return { 
            name: user.name, color: user.color,
            purseLeft: parseFloat(user.purseRemaining).toFixed(1),
            playing11: user.playing11,
            bench: user.squad.filter(p => !user.playing11.find(xi => xi.name === p.name)),
            aiRating: aiEvaluation.score,
            aiAnalysis: aiEvaluation.reasons
        };
    }); 
    
    leaderboard.sort((a, b) => b.aiRating - a.aiRating || b.purseLeft - a.purseLeft);
    io.to(roomCode).emit('gameEnded', leaderboard);
    
    try {
        const matchRef = ref(db, 'match_history');
        await push(matchRef, { roomCode, results: leaderboard, timestamp: serverTimestamp() });
    } catch (e) { console.error(e); }
}

io.on('connection', (socket) => {
  socket.on('createRoom', (settings) => {
    try {
        const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        settings.startingPurse = parseFloat(settings.startingPurse) || 100;
        
        activeRooms[roomCode] = { createdAt: Date.now(), hostId: socket.id, users: [], availablePlayers: [], auctionStarted: false, isSelling: false, tradePhase: false, build11Phase: false, bidHistory: [], bidTimestamps: [], settings: settings };
        socket.join(roomCode);
        activeRooms[roomCode].users.push({ id: socket.id, name: settings.teamName || 'Host', color: settings.teamColor || '#ff003c', purseRemaining: settings.startingPurse, squad: [], playing11: [] });
        socket.emit('roomCreated', { code: roomCode, purse: settings.startingPurse });
    } catch (err) {
        console.error("Create Room Crash:", err);
    }
  });

  socket.on('joinRoom', (data) => {
    try {
        const roomCode = data.roomCode.toUpperCase();
        const room = activeRooms[roomCode];
        
        if (room) {
            socket.join(roomCode);
            
            let existingUser = room.users.find(u => u.name === data.teamName);
            
            if (existingUser) {
                if (room.hostId === existingUser.id) { room.hostId = socket.id; }
                existingUser.id = socket.id;
            } else {
                const startMoney = parseFloat(room.settings.startingPurse) || 100;
                existingUser = { id: socket.id, name: data.teamName || `Player ${room.users.length + 1}`, color: data.teamColor || '#00e5ff', purseRemaining: startMoney, squad: [], playing11: [] };
                room.users.push(existingUser);
            }

            let isUserHost = (room.hostId === socket.id);
            socket.emit('roomJoined', { code: roomCode, purse: existingUser.purseRemaining, rules: room.settings, isHost: isUserHost });

            if (room.build11Phase) {
                socket.emit('build11PhaseStarted', room.users);
            } else if (room.tradePhase) {
                socket.emit('tradePhaseStarted', room.users);
            } else if (room.auctionStarted) {
                if (room.currentPlayer) {
                    socket.emit('newPlayerUp', { player: room.currentPlayer });
                    if (room.highestBidder) socket.emit('bidUpdated', { bidAmount: room.currentBid, bidderName: room.highestBidder.name, bidderColor: room.highestBidder.color, hypeMode: false });
                    socket.emit('timerUpdate', room.timeLeft);
                } else {
                    socket.emit('waitingForNextPlayer', room.availablePlayers);
                }
            }
        }
    } catch (err) {
        console.error("Join Room Crash:", err);
    }
  });

  socket.on('updateRulesAndStart', (data) => {
      const room = activeRooms[data.roomCode];
      if (room && room.hostId === socket.id) {
          room.settings.maxSquad = data.maxSquad;
          room.settings.maxOverseas = data.maxOverseas;
          room.settings.format = data.format;

          let pool = (data.format === 'All') ? playersData : playersData.filter(p => p.formats && p.formats.includes(data.format));
          room.availablePlayers = pool.map(p => ({ ...p, basePrice: p.basePrice / 100 })).sort(() => Math.random() - 0.5); 

          io.to(data.roomCode).emit('rulesUpdated', room.settings);
          room.auctionStarted = true; 
          promptHostForNextPlayer(data.roomCode);
      }
  });

  socket.on('bringPlayerUp', (data) => {
      const room = activeRooms[data.roomCode];
      if (room && room.hostId === socket.id && !room.tradePhase && !room.build11Phase) {
          if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
          room.isSelling = false; 

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
      if (!user) return; 
      if (room.highestBidder && room.highestBidder.id === socket.id) return;
      
      let now = Date.now();
      room.bidTimestamps.push(now);
      if(room.bidTimestamps.length > 3) room.bidTimestamps.shift();
      
      let isHypeMode = false;
      if(room.bidTimestamps.length === 3 && (now - room.bidTimestamps[0] <= 3000)) { isHypeMode = true; }

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
              bidAmount: room.currentBid, bidderName: room.highestBidder ? room.highestBidder.name : 'None',
              bidderColor: room.highestBidder ? room.highestBidder.color : '#fff', hypeMode: false
          });
          startTimer(roomCode, false);
      }
  });

  socket.on('endAuctionEarly', (roomCode) => {
      const room = activeRooms[roomCode];
      if (room && room.hostId === socket.id && !room.tradePhase && !room.build11Phase) {
          if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
          room.isSelling = false;
          room.currentPlayer = null; 
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

  socket.on('startBuildXI', (roomCode) => {
      const room = activeRooms[roomCode];
      if (room && room.hostId === socket.id && room.tradePhase) {
          startBuild11Phase(roomCode);
      }
  });

  socket.on('submitXI', (data) => {
      const room = activeRooms[data.roomCode];
      if (room && room.build11Phase) {
          const user = room.users.find(u => u.id === socket.id);
          if(user) user.playing11 = data.xi;
      }
  });

  socket.on('evaluateResults', (roomCode) => {
      const room = activeRooms[roomCode]; 
      if (room && room.hostId === socket.id && room.build11Phase) {
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
