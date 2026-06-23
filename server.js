const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const JOKER = 13;

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
    function handlePlayerExit() {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const pIdx = room.players.findIndex(p => p.id === socket.id);
            if (pIdx !== -1) {
                room.players.splice(pIdx, 1);
                socket.leave(roomId);
                
                if (room.readyPlayers.includes(socket.id)) {
                    room.readyPlayers = room.readyPlayers.filter(id => id !== socket.id);
                }

                if (room.players.filter(p => !p.isAI).length === 0) {
                    delete rooms[roomId];
                } else {
                    if (!room.players.some(p => p.isHost)) {
                        const newHost = room.players.find(p => !p.isAI);
                        if (newHost) newHost.isHost = true;
                    }
                    if (room.status === 'lobby' || room.status === 'seon_drawing') {
                        io.to(roomId).emit('roomUpdated', { roomId: roomId, players: room.players.filter(p => !p.isAI), readyPlayers: room.readyPlayers, betAmount: room.betAmount, maxPlayers: room.maxPlayers });
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

    socket.on('createRoom', ({ playerName }) => {
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[roomId] = {
            id: roomId,
            maxPlayers: 4,
            betAmount: 1000,
            players: [{ id: socket.id, name: playerName, hand: [], hasPassed: false, isHost: true, isAI: false }],
            currentTurnIdx: 0,
            center: { cards: [], count: 0, rank: 99, ownerId: null },
            status: 'lobby',
            finishedPlayers: [],
            lastRoundRanks: [],
            taxLogs: [],
            seonPickedData: {},
            readyPlayers: [],
            balances: {},
            transactions: []
        };
        socket.join(roomId);
        socket.emit('roomCreated', { roomId, players: rooms[roomId].players, betAmount: rooms[roomId].betAmount, maxPlayers: rooms[roomId].maxPlayers });
    });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMsg', '방을 찾을 수 없습니다.');
        if (room.status !== 'lobby') return socket.emit('errorMsg', '이미 게임이 시작된 방입니다.');
        if (room.players.some(p => p.id === socket.id)) return;
        if (room.players.filter(p => !p.isAI).length >= room.maxPlayers) return socket.emit('errorMsg', `방이 가득 찼습니다. (최대 ${room.maxPlayers}인)`);

        room.players.push({ id: socket.id, name: playerName, hand: [], hasPassed: false, isHost: false, isAI: false });
        socket.join(roomId);
        io.to(roomId).emit('roomUpdated', { roomId: roomId, players: room.players.filter(p => !p.isAI), readyPlayers: room.readyPlayers, betAmount: room.betAmount, maxPlayers: room.maxPlayers });
    });

    socket.on('updateRoomSettings', ({ maxPlayers, betAmount }) => {
        const room = getRoomBySocket(socket.id);
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isHost) return;
        if (room.readyPlayers.length > 0) return;

        room.maxPlayers = parseInt(maxPlayers) || 4;
        room.betAmount = parseInt(betAmount) || 0;
        io.to(room.id).emit('roomUpdated', { roomId: room.id, players: room.players.filter(p => !p.isAI), readyPlayers: room.readyPlayers, betAmount: room.betAmount, maxPlayers: room.maxPlayers });
    });

    socket.on('toggleReady', () => {
        const room = getRoomBySocket(socket.id);
        if (!room) return;
        if (room.readyPlayers.includes(socket.id)) {
            room.readyPlayers = room.readyPlayers.filter(id => id !== socket.id);
        } else {
            room.readyPlayers.push(socket.id);
        }
        io.to(room.id).emit('roomUpdated', { roomId: room.id, players: room.players.filter(p => !p.isAI), readyPlayers: room.readyPlayers, betAmount: room.betAmount, maxPlayers: room.maxPlayers });
    });

    socket.on('sendEmote', (emote) => {
        const room = getRoomBySocket(socket.id);
        if (room) io.to(room.id).emit('playerEmoted', { id: socket.id, emote });
    });

    socket.on('startGame', () => {
        const room = getRoomBySocket(socket.id);
        if (!room) return;

        const humanPlayers = room.players.filter(p => !p.isAI);
        if (room.readyPlayers.length < humanPlayers.length - 1) {
            return socket.emit('errorMsg', '모든 플레이어가 준비를 완료해야 합니다.');
        }

        if (room.players.length < room.maxPlayers) {
            const botsNeeded = room.maxPlayers - room.players.length;
            for (let i = 1; i <= botsNeeded; i++) {
                room.players.push({ id: `ai_${i}_${Date.now()}`, name: `🤖 AI 봇 ${i}`, hand: [], hasPassed: false, isHost: false, isAI: true });
            }
        }

        room.status = 'seon_drawing';
        room.seonPickedData = {};

        room.players.forEach(p => {
            if (p.isAI) room.seonPickedData[p.id] = { name: p.name, card: Math.floor(Math.random() * 12) + 1, isAI: true };
        });

        io.to(room.id).emit('seonDrawPhaseInit', { totalPlayers: room.players.length });
    });

    socket.on('pickSeonCard', ({ cardIndex }) => {
        const room = getRoomBySocket(socket.id);
        if (!room || room.status !== 'seon_drawing') return;
        if (room.seonPickedData[socket.id]) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        room.seonPickedData[socket.id] = { name: player.name, card: Math.floor(Math.random() * 12) + 1, isAI: false };

        if (Object.keys(room.seonPickedData).length === room.players.length) {
            let sortedResults = Object.keys(room.seonPickedData).map(id => ({
                id, name: room.seonPickedData[id].name, card: room.seonPickedData[id].card
            })).sort((a, b) => a.card - b.card);

            const winnerId = sortedResults[0].id;
            const winnerName = sortedResults[0].name;

            let newPlayersOrder = [];
            sortedResults.forEach(res => newPlayersOrder.push(room.players.find(p => p.id === res.id)));
            room.players = newPlayersOrder;

            io.to(room.id).emit('seonDrawResults', { drawResults: sortedResults, winnerId, winnerName });

            setTimeout(() => {
                if (!rooms[room.id] || rooms[room.id].status !== 'seon_drawing') return;
                room.status = 'playing';
                room.finishedPlayers = [];
                room.center = { cards: [], count: 0, rank: 99, ownerId: null };
                room.players.forEach(p => { p.hand = []; p.hasPassed = false; });
                room.lastRoundRanks = room.players.map(p => p.id);
                
                distributeCards(room);
                room.currentTurnIdx = 0;

                // ⭐️ 시작할 때 손패가 무조건 한 번만, 그리고 100% 정렬된 상태로 전송되도록 일원화
                room.players.forEach(p => p.hand.sort((a,b)=>a-b));

                io.to(room.id).emit('gameStarted', {
                    players: room.players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length, isAI: p.isAI })),
                    currentTurnId: room.players[0].id,
                    lastRoundRanks: room.lastRoundRanks
                });

                room.players.forEach(p => { if (!p.isAI) io.to(p.id).emit('yourHand', p.hand); });
                handleAITurnIfNeeded(room.id, room);
            }, 4500);
        } else {
            io.to(room.id).emit('seonPickProgress', { count: Object.keys(room.seonPickedData).length });
        }
    });

    socket.on('playCards', ({ indices }) => {
        const room = getRoomBySocket(socket.id);
        if (!room || room.status !== 'playing') return;
        
        const player = room.players[room.currentTurnIdx];
        if (player.id !== socket.id) return socket.emit('errorMsg', '당신의 차례가 아닙니다.');

        indices.sort((a, b) => b - a);
        let selectedCards = indices.map(i => player.hand[i]);
        let nonJoker = selectedCards.filter(c => c !== JOKER);
        let eRank = nonJoker.length === 0 ? JOKER : nonJoker[0];

        if (!nonJoker.every(c => c === eRank)) return socket.emit('errorMsg', '조커 외에는 같은 숫자여야 합니다.');
        if (room.center.count > 0 && (selectedCards.length !== room.center.count || eRank >= room.center.rank)) {
            return socket.emit('errorMsg', '필드의 규칙에 맞지 않는 카드입니다.');
        }

        indices.forEach(i => player.hand.splice(i, 1));
        socket.emit('yourHand', player.hand);
        
        executePlayLogic(room.id, room, player, selectedCards, eRank);
    });

    socket.on('passTurn', () => {
        const room = getRoomBySocket(socket.id);
        if (!room || room.status !== 'playing') return;
        
        const player = room.players[room.currentTurnIdx];
        if (player.id !== socket.id) return socket.emit('errorMsg', '당신의 차례가 아닙니다.');
        if (room.center.count === 0) return socket.emit('errorMsg', '선 플레이어는 패스할 수 없습니다.');

        executePassLogic(room.id, room, player);
    });

    socket.on('playNextRound', () => {
        const room = getRoomBySocket(socket.id);
        if (!room || room.status !== 'ended') return;
        
        if (!room.readyPlayers.includes(socket.id)) room.readyPlayers.push(socket.id);
        const playerReady = room.players.find(p => p.id === socket.id);
        io.to(room.id).emit('chatMsg', `✅ [${playerReady.name}] 다음 라운드 레디!`);

        const humanPlayers = room.players.filter(p => !p.isAI);
        
        if (room.readyPlayers.length >= humanPlayers.length) {
            room.status = 'tax_phase';
            io.to(room.id).emit('hideResultScreen');
            
            room.lastRoundRanks = [...room.finishedPlayers];
            room.finishedPlayers = [];
            room.readyPlayers = [];
            room.center = { cards: [], count: 0, rank: 99, ownerId: null };
            room.players.forEach(p => { p.hand = []; p.hasPassed = false; });
            
            let newPlayersOrder = [];
            room.lastRoundRanks.forEach(rId => {
                newPlayersOrder.push(room.players.find(p => p.id === rId));
            });
            room.players = newPlayersOrder;

            distributeCards(room);
            executeTaxPhase(room.id, room);
        }
    });

    socket.on('submitTaxHand', ({ targetId, indices }) => {
        const room = getRoomBySocket(socket.id);
        if (!room) return;
        const giver = room.players.find(p => p.id === socket.id);
        const receiver = room.players.find(p => p.id === targetId);
        
        indices.sort((a,b) => b-a);
        let taxCards = indices.map(i => giver.hand.splice(i, 1)[0]);
        receiver.hand.push(...taxCards);
        room.taxLogs.push({ fromId: giver.id, toId: receiver.id, fromName: giver.name, toName: receiver.name, cards: taxCards });
        
        socket.emit('yourHand', giver.hand);
        
        let expectedLogs = 0; let total = room.players.length;
        if (total === 5) expectedLogs = 2;
        else if (total === 6 || total === 7) expectedLogs = 4;
        else if (total >= 8) expectedLogs = 6;

        if (room.taxLogs.length === expectedLogs) {
            io.to(room.id).emit('taxPhasePersonalResults', { taxLogs: room.taxLogs });
            setTimeout(() => {
                // ⭐️ 서버에서 완벽히 정렬을 끝낸 뒤 startNormalRound를 통해 한 번에 발송되도록 꼬임 제거
                startNormalRound(room.id, room);
            }, 3500);
        }
    });
});

function clearTrickAndSetLead(roomId, room) {
    let trickWinnerId = room.center.ownerId;
    room.center = { cards: [], count: 0, rank: 99, ownerId: null };
    room.players.forEach(p => p.hasPassed = false);

    let nextTurnId = trickWinnerId;
    if (!nextTurnId || room.finishedPlayers.includes(nextTurnId)) {
        let winnerIdx = room.players.findIndex(p => p.id === trickWinnerId);
        if (winnerIdx === -1) winnerIdx = 0;
        
        let nextIdx = (winnerIdx + 1) % room.players.length;
        let loopCount = 0;
        while (room.finishedPlayers.includes(room.players[nextIdx].id) && loopCount < room.players.length) {
            nextIdx = (nextIdx + 1) % room.players.length;
            loopCount++;
        }
        nextTurnId = room.players[nextIdx].id;
    }
    
    room.currentTurnIdx = room.players.findIndex(p => p.id === nextTurnId);
    let nextPlayer = room.players.find(p => p.id === nextTurnId);
    if (nextPlayer) io.to(roomId).emit('chatMsg', `📯 [${nextPlayer.name}] 플레이어가 선을 잡았습니다!`);
    io.to(roomId).emit('newRound', { currentTurnId: nextTurnId });
}

function advanceTurn(room) {
    let loopCount = 0;
    do {
        room.currentTurnIdx = (room.currentTurnIdx + 1) % room.players.length;
        loopCount++;
        if (loopCount > room.players.length) break;
    } while (room.players[room.currentTurnIdx].hasPassed || room.finishedPlayers.includes(room.players[room.currentTurnIdx].id));
}

function handleAITurnIfNeeded(roomId, room) {
    if (room.status !== 'playing') return;
    const player = room.players[room.currentTurnIdx];
    if (!player || !player.isAI) return;

    setTimeout(() => {
        let aiHand = player.hand;
        let groups = {};
        aiHand.forEach((r, idx) => { if (!groups[r]) groups[r] = []; groups[r].push(idx); });

        if (room.center.count === 0) {
            let bestRank = -1; let maxCount = 0;
            for (let r in groups) {
                let num = Number(r);
                if (num !== JOKER && (groups[r].length > maxCount || (groups[r].length === maxCount && num > bestRank))) {
                    maxCount = groups[r].length; bestRank = num;
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
        
        const humanFinished = room.finishedPlayers.filter(id => {
            const p = room.players.find(pl => pl.id === id);
            return p && !p.isAI;
        });

        let roundLog = null;
        if (humanFinished.length >= 2 && room.betAmount > 0) {
            const firstHumanId = humanFinished[0];
            const lastHumanId = humanFinished[humanFinished.length - 1];
            const firstHuman = room.players.find(p => p.id === firstHumanId);
            const lastHuman = room.players.find(p => p.id === lastHumanId);

            roundLog = { from: lastHuman.name, to: firstHuman.name, amount: room.betAmount };
            room.transactions.push(roundLog);

            if (!room.balances[firstHuman.name]) room.balances[firstHuman.name] = 0;
            if (!room.balances[lastHuman.name]) room.balances[lastHuman.name] = 0;
            room.balances[firstHuman.name] += room.betAmount;
            room.balances[lastHuman.name] -= room.betAmount;
        }

        let playersData = room.players.map(p => ({ id: p.id, name: p.name }));
        io.to(roomId).emit('gameOver', { finishedPlayers: room.finishedPlayers, playersData, balances: room.balances, roundLog });
        return;
    }

    let activePlayers = room.players.filter(p => !p.hasPassed && !room.finishedPlayers.includes(p.id));
    if (activePlayers.length === 0 || (activePlayers.length === 1 && activePlayers[0].id === room.center.ownerId)) {
        clearTrickAndSetLead(roomId, room);
    } else {
        advanceTurn(room);
    }
    
    broadcastGameState(roomId, room);
    handleAITurnIfNeeded(roomId, room);
}

function executePassLogic(roomId, room, player) {
    player.hasPassed = true;
    io.to(roomId).emit('playerPassed', { name: player.name });

    let activePlayers = room.players.filter(p => !p.hasPassed && !room.finishedPlayers.includes(p.id));
    if (activePlayers.length === 0 || (activePlayers.length === 1 && activePlayers[0].id === room.center.ownerId)) {
        clearTrickAndSetLead(roomId, room);
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
}

function broadcastGameState(roomId, room) {
    io.to(roomId).emit('gameStateUpdated', {
        center: room.center,
        currentTurnId: room.players[room.currentTurnIdx].id,
        finishedPlayers: room.finishedPlayers,
        players: room.players.map(p => ({
            id: p.id, name: p.name, cardCount: p.hand.length, hasPassed: p.hasPassed, isEscaped: room.finishedPlayers.includes(p.id), isAI: p.isAI
        }))
    });
}

function executeTaxPhase(roomId, room) {
    let total = room.players.length; let taxRules = []; room.taxLogs = [];
    
    if (total <= 4) taxRules = [];
    else if (total === 5) taxRules.push({ highRank: 0, lowRank: total - 1, count: 1 });
    else if (total === 6 || total === 7) { taxRules.push({ highRank: 0, lowRank: total - 1, count: 2 }); taxRules.push({ highRank: 1, lowRank: total - 2, count: 1 }); }
    else if (total >= 8) { taxRules.push({ highRank: 0, lowRank: total - 1, count: 3 }); taxRules.push({ highRank: 1, lowRank: total - 2, count: 2 }); taxRules.push({ highRank: 2, lowRank: total - 3, count: 1 }); }

    if (taxRules.length === 0) {
        startNormalRound(roomId, room);
        return;
    }

    let humanTaxWaiting = false;
    taxRules.forEach(rule => {
        let hId = room.lastRoundRanks[rule.highRank]; let lId = room.lastRoundRanks[rule.lowRank]; let count = rule.count;
        let lowPlayer = room.players.find(p => p.id === lId); let highPlayer = room.players.find(p => p.id === hId);

        let bestCards = lowPlayer.hand.filter(c => c !== JOKER).sort((a,b)=>a-b).slice(0, count);
        bestCards.forEach(c => lowPlayer.hand.splice(lowPlayer.hand.indexOf(c), 1));
        highPlayer.hand.push(...bestCards);
        room.taxLogs.push({ fromId: lowPlayer.id, toId: highPlayer.id, fromName: lowPlayer.name, toName: highPlayer.name, cards: bestCards });
    });

    room.players.forEach(p => { if(!p.isAI) io.to(p.id).emit('yourHand', p.hand); });

    taxRules.forEach(rule => {
        let hId = room.lastRoundRanks[rule.highRank]; let lId = room.lastRoundRanks[rule.lowRank]; let count = rule.count;
        let lowPlayer = room.players.find(p => p.id === lId); let highPlayer = room.players.find(p => p.id === hId);

        if (highPlayer.isAI) {
            highPlayer.hand.sort((a,b)=>a-b);
            let worstCards = highPlayer.hand.splice(highPlayer.hand.length - count, count);
            lowPlayer.hand.push(...worstCards);
            room.taxLogs.push({ fromId: highPlayer.id, toId: lowPlayer.id, fromName: highPlayer.name, toName: lowPlayer.name, cards: worstCards });
        } else {
            humanTaxWaiting = true;
            let log = room.taxLogs.find(l => l.toName === highPlayer.name && l.fromName === lowPlayer.name);
            io.to(hId).emit('taxReceived', { cards: log.cards, count, targetName: lowPlayer.name, targetId: lId });
        }
    });

    if (!humanTaxWaiting) {
        io.to(roomId).emit('taxPhaseWaiting', { taxLogs: room.taxLogs });
        io.to(roomId).emit('taxPhasePersonalResults', { taxLogs: room.taxLogs });
        setTimeout(() => {
            startNormalRound(roomId, room);
        }, 3500);
    } else {
        io.to(roomId).emit('taxPhaseWaiting', { taxLogs: room.taxLogs });
    }
}

function startNormalRound(roomId, room) {
    room.status = 'playing';
    // ⭐️ 여기서 전원의 손패를 100% 정렬한 뒤 화면으로 쏴줍니다!
    room.players.forEach(p => p.hand.sort((a,b)=>a-b));
    room.currentTurnIdx = 0;
    
    io.to(roomId).emit('gameStarted', {
        players: room.players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length, isAI: p.isAI })),
        currentTurnId: room.players[0].id,
        lastRoundRanks: room.lastRoundRanks
    });

    // ⭐️ 손패 동기화 배포
    room.players.forEach(p => { if (!p.isAI) io.to(p.id).emit('yourHand', p.hand); });

    handleAITurnIfNeeded(roomId, room);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`서버 작동 포트: ${PORT}`); });
