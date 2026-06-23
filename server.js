const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" }
});
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const JOKER = 13;

// ⭐️ 핵심 해결 로직: 클라이언트가 방 번호를 몰라도 소켓 ID로 방을 자동 색출
function getRoomBySocket(socketId) {
    for (let rId in rooms) {
        if (rooms[rId].players.some(p => p.id === socketId)) return rooms[rId];
    }
    return null;
}

function createDeck() {
    let deck = [];
    for (let i = 1; i <= 12; i++) {
        for (let j = 0; j < i; j++) deck.push(i);
    }
    deck.push(JOKER, JOKER);
    return deck.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    // ⭐️ 메인으로 돌아가기 & 연결 끊김 처리 (방장 이양 기능 포함)
    function handlePlayerExit() {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const pIdx = room.players.findIndex(p => p.id === socket.id);
            if (pIdx !== -1) {
                room.players.splice(pIdx, 1);
                socket.leave(roomId);
                if (room.players.filter(p => !p.isAI).length === 0) {
                    delete rooms[roomId];
                } else {
                    if (!room.players.some(p => p.isHost)) {
                        const newHost = room.players.find(p => !p.isAI);
                        if (newHost) newHost.isHost = true;
                    }
                    if (room.status === 'lobby') {
                        io.to(roomId).emit('roomUpdated', { roomId: roomId, players: room.players.filter(p => !p.isAI) });
                    } else {
                        room.status = 'lobby';
                        room.players = room.players.filter(p => !p.isAI);
                        io.to(roomId).emit('chatMsg', '플레이어가 퇴장하여 대기실로 리셋되었습니다.');
                        io.to(roomId).emit('forceLobby', { roomId: roomId, players: room.players });
                    }
                }
                break;
            }
        }
    }

    socket.on('disconnect', handlePlayerExit);
    socket.on('leaveRoom', handlePlayerExit);

    socket.on('createRoom', (playerName) => {
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[roomId] = {
            id: roomId,
            players: [{ id: socket.id, name: playerName, hand: [], hasPassed: false, isHost: true, isAI: false }],
            currentTurnIdx: 0,
            center: { cards: [], count: 0, rank: 99, ownerId: null },
            status: 'lobby',
            finishedPlayers: [],
            lastRoundRanks: [],
            taxLogs: []
        };
        socket.join(roomId);
        socket.emit('roomCreated', { roomId, players: rooms[roomId].players });
    });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMsg', '방을 찾을 수 없습니다.');
        if (room.status !== 'lobby') return socket.emit('errorMsg', '이미 게임이 시작된 방입니다.');
        if (room.players.some(p => p.id === socket.id)) return;
        if (room.players.filter(p => !p.isAI).length >= 8) return socket.emit('errorMsg', '방이 가득 찼습니다. (최대 8인)');

        room.players.push({ id: socket.id, name: playerName, hand: [], hasPassed: false, isHost: false, isAI: false });
        socket.join(roomId);
        io.to(roomId).emit('roomUpdated', { roomId: roomId, players: room.players.filter(p => !p.isAI) });
    });

    socket.on('startGame', () => {
        const room = getRoomBySocket(socket.id);
        if (!room) return;

        const humanPlayers = room.players.filter(p => !p.isAI);
        if (humanPlayers.length < 4) {
            const botsNeeded = 4 - humanPlayers.length;
            for (let i = 1; i <= botsNeeded; i++) {
                room.players.push({ id: `ai_${i}_${Date.now()}`, name: `🤖 AI 봇 ${i}`, hand: [], hasPassed: false, isHost: false, isAI: true });
            }
        }

        room.status = 'playing';
        room.finishedPlayers = [];
        room.players = room.players.sort(() => Math.random() - 0.5);
        room.lastRoundRanks = room.players.map(p => p.id);

        distributeCards(room);
        room.currentTurnIdx = 0;

        io.to(room.id).emit('gameStarted', {
            players: room.players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length, isAI: p.isAI })),
            currentTurnId: room.players[room.currentTurnIdx].id,
            lastRoundRanks: room.lastRoundRanks
        });

        room.players.forEach(p => { if (!p.isAI) io.to(p.id).emit('yourHand', p.hand); });
        handleAITurnIfNeeded(room.id, room);
    });

    // ⭐️ 카드 낼 때 절대 방 번호를 잃어버리지 않음 (getRoomBySocket 적용)
    socket.on('playCards', ({ indices }) => {
        const room = getRoomBySocket(socket.id);
        if (!room || room.status !== 'playing') return;
        const player = room.players[room.currentTurnIdx];
        if (player.id !== socket.id || player.isAI) return socket.emit('errorMsg', '지금은 당신의 차례가 아닙니다.');

        indices.sort((a, b) => b - a);
        let selectedCards = indices.map(i => player.hand[i]);
        let nonJoker = selectedCards.filter(c => c !== JOKER);
        let eRank = nonJoker.length === 0 ? JOKER : nonJoker[0];

        if (!nonJoker.every(c => c === eRank)) return socket.emit('errorMsg', '조커 외에는 같은 숫자여야 합니다.');
        if (room.center.count > 0 && (selectedCards.length !== room.center.count || eRank >= room.center.rank)) {
            return socket.emit('errorMsg', '필드의 규칙에 맞지 않는 카드입니다.');
        }

        indices.forEach(i => player.hand.splice(i, 1));
        executePlayLogic(room.id, room, player, selectedCards, eRank);
    });

    socket.on('passTurn', () => {
        const room = getRoomBySocket(socket.id);
        if (!room || room.status !== 'playing') return;
        const player = room.players[room.currentTurnIdx];
        if (player.id !== socket.id || player.isAI) return;
        if (room.center.count === 0) return socket.emit('errorMsg', '선 플레이어는 패스할 수 없습니다.');

        executePassLogic(room.id, room, player);
    });

    socket.on('playNextRound', () => {
        const room = getRoomBySocket(socket.id);
        if (!room) return;
        
        room.lastRoundRanks = [...room.finishedPlayers];
        room.finishedPlayers = [];
        room.center = { cards: [], count: 0, rank: 99, ownerId: null };
        room.players.forEach(p => { p.hand = []; p.hasPassed = false; });
        
        distributeCards(room);
        executeTaxPhase(room.id, room);
    });

    socket.on('submitTaxHand', ({ targetId, indices }) => {
        const room = getRoomBySocket(socket.id);
        if (!room) return;
        const giver = room.players.find(p => p.id === socket.id);
        const receiver = room.players.find(p => p.id === targetId);
        
        indices.sort((a,b) => b-a);
        let taxCards = indices.map(i => giver.hand.splice(i, 1)[0]);
        receiver.hand.push(...taxCards);
        room.taxLogs.push({ from: giver.name, to: receiver.name, cards: taxCards });
        
        startNormalRound(room.id, room);
    });
});

function handleAITurnIfNeeded(roomId, room) {
    if (room.status !== 'playing') return;
    const player = room.players[room.currentTurnIdx];
    if (!player || !player.isAI) return;

    setTimeout(() => {
        let aiHand = player.hand;
        let groups = {};
        aiHand.forEach((r, idx) => {
            if (!groups[r]) groups[r] = [];
            groups[r].push(idx);
        });

        if (room.center.count === 0) {
            let bestRank = -1; let maxCount = 0;
            for (let r in groups) {
                let num = Number(r);
                if (num !== JOKER) {
                    if (groups[r].length > maxCount || (groups[r].length === maxCount && num > bestRank)) {
                        maxCount = groups[r].length; bestRank = num;
                    }
                }
            }
            let pIndices = bestRank !== -1 ? groups[bestRank] : groups[JOKER];
            let selectedCards = pIndices.map(i => player.hand[i]);
            pIndices.sort((a, b) => b - a).forEach(i => player.hand.splice(i, 1));
            executePlayLogic(roomId, room, player, selectedCards, bestRank !== -1 ? bestRank : JOKER);
        } else {
            let bestPlay = null; let maxRank = -1;
            for (let r in groups) {
                let num = Number(r);
                if (num === JOKER || num >= room.center.rank) continue;
                let avail = groups[num].length;
                let jAvail = groups[JOKER] ? groups[JOKER].length : 0;
                if (avail >= room.center.count) {
                    if (num > maxRank) { maxRank = num; bestPlay = groups[num].slice(0, room.center.count); }
                } else if (avail + jAvail >= room.center.count) {
                    if (num > maxRank) { maxRank = num; bestPlay = [...groups[num], ...groups[JOKER].slice(0, room.center.count - avail)]; }
                }
            }

            if (bestPlay) {
                let selectedCards = bestPlay.map(i => player.hand[i]);
                bestPlay.sort((a, b) => b - a).forEach(i => player.hand.splice(i, 1));
                executePlayLogic(roomId, room, player, selectedCards, maxRank);
            } else {
                executePassLogic(roomId, room, player);
            }
        }
    }, 1200);
}

function executePlayLogic(roomId, room, player, selectedCards, eRank) {
    room.center = { cards: selectedCards, count: selectedCards.length, rank: eRank, ownerId: player.id };
    io.to(roomId).emit('chatMsg', `♣️ ${player.name}이(가) [${eRank === JOKER ? 'J' : eRank}] ${selectedCards.length}장을 냈습니다.`);

    if (player.hand.length === 0 && !room.finishedPlayers.includes(player.id)) {
        room.finishedPlayers.push(player.id);
        io.to(roomId).emit('playerEscaped', { name: player.name });
    }
    if (room.finishedPlayers.length >= room.players.length - 1) {
        room.status = 'ended';
        room.players.forEach(p => { if(!room.finishedPlayers.includes(p.id)) room.finishedPlayers.push(p.id); });
        io.to(roomId).emit('gameOver', { finishedPlayers: room.finishedPlayers });
        return;
    }
    advanceTurn(room);
    broadcastGameState(roomId, room);
    handleAITurnIfNeeded(roomId, room);
}

function executePassLogic(roomId, room, player) {
    player.hasPassed = true;
    io.to(roomId).emit('playerPassed', { name: player.name });

    let activePlayers = room.players.filter(p => !p.hasPassed && !room.finishedPlayers.includes(p.id));
    if (activePlayers.length === 0 || (activePlayers.length === 1 && activePlayers[0].id === room.center.ownerId)) {
        room.center = { cards: [], count: 0, rank: 99, ownerId: null };
        room.players.forEach(p => p.hasPassed = false);
        let nextTurnId = room.center.ownerId || room.lastRoundRanks.find(id => !room.finishedPlayers.includes(id));
        if (room.finishedPlayers.includes(nextTurnId)) {
            nextTurnId = room.lastRoundRanks.find(id => !room.finishedPlayers.includes(id));
        }
        room.currentTurnIdx = room.players.findIndex(p => p.id === nextTurnId);
        io.to(roomId).emit('newRound', { currentTurnId: nextTurnId });
    } else {
        advanceTurn(room);
    }
    broadcastGameState(roomId, room);
    handleAITurnIfNeeded(roomId, room);
}

function distributeCards(room) {
    let deck = createDeck(); let p = 0;
    while (deck.length > 0) {
        room.players[p].hand.push(deck.pop());
        p = (p + 1) % room.players.length;
    }
    room.players.forEach(pl => pl.hand.sort((a, b) => a - b));
}

function advanceTurn(room) {
    do {
        room.currentTurnIdx = (room.currentTurnIdx + 1) % room.players.length;
    } while (room.players[room.currentTurnIdx].hasPassed || room.finishedPlayers.includes(room.players[room.currentTurnIdx].id));
}

function broadcastGameState(roomId, room) {
    io.to(roomId).emit('gameStateUpdated', {
        center: room.center,
        currentTurnId: room.players[room.currentTurnIdx].id,
        players: room.players.map(p => ({
            id: p.id, name: p.name, cardCount: p.hand.length, hasPassed: p.hasPassed, isEscaped: room.finishedPlayers.includes(p.id), isAI: p.isAI
        }))
    });
}

function executeTaxPhase(roomId, room) {
    let total = room.players.length; let taxRules = []; room.taxLogs = [];
    if (total === 4 || total === 5) taxRules.push({ highRank: 0, lowRank: total - 1, count: 1 });
    else if (total === 6 || total === 7) { taxRules.push({ highRank: 0, lowRank: total - 1, count: 2 }); taxRules.push({ highRank: 1, lowRank: total - 2, count: 1 }); }
    else if (total === 8) { taxRules.push({ highRank: 0, lowRank: total - 1, count: 3 }); taxRules.push({ highRank: 1, lowRank: total - 2, count: 2 }); taxRules.push({ highRank: 2, lowRank: total - 3, count: 1 }); }

    let humanTaxWaiting = false;
    taxRules.forEach(rule => {
        let hId = room.lastRoundRanks[rule.highRank]; let lId = room.lastRoundRanks[rule.lowRank]; let count = rule.count;
        let lowPlayer = room.players.find(p => p.id === lId); let highPlayer = room.players.find(p => p.id === hId);

        let bestCards = lowPlayer.hand.filter(c => c !== JOKER).sort((a,b)=>a-b).slice(0, count);
        bestCards.forEach(c => lowPlayer.hand.splice(lowPlayer.hand.indexOf(c), 1));
        highPlayer.hand.push(...bestCards);
        room.taxLogs.push({ from: lowPlayer.name, to: highPlayer.name, cards: bestCards });

        if (highPlayer.isAI) {
            highPlayer.hand.sort((a,b)=>a-b);
            let worstCards = highPlayer.hand.splice(highPlayer.hand.length - count, count);
            lowPlayer.hand.push(...worstCards);
            room.taxLogs.push({ from: highPlayer.name, to: lowPlayer.name, cards: worstCards });
        } else {
            humanTaxWaiting = true;
            io.to(hId).emit('taxReceived', { cards: bestCards, count, targetName: lowPlayer.name, targetId: lId });
        }
    });

    room.players.forEach(p => { if(!p.isAI) io.to(p.id).emit('yourHand', p.hand); });
    io.to(roomId).emit('taxPhaseStarted', { taxLogs: room.taxLogs });

    if (!humanTaxWaiting) { startNormalRound(roomId, room); }
}

function startNormalRound(roomId, room) {
    room.status = 'playing';
    room.players.forEach(p => p.hand.sort((a,b)=>a-b));
    let firstPlayerId = room.lastRoundRanks[0];
    room.currentTurnIdx = room.players.findIndex(p => p.id === firstPlayerId);
    
    io.to(roomId).emit('gameStarted', {
        players: room.players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length, isAI: p.isAI })),
        currentTurnId: firstPlayerId,
        lastRoundRanks: room.lastRoundRanks
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`서버 작동 포트: ${PORT}`); });
