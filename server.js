const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const JOKER = 13;
const globalLedger = {};

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

function notifyTurn(roomId, turnId) {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === turnId);
    if (player && !player.isAI) {
        io.to(player.id).emit('yourTurnSFX');
    }
}

function updatePlayerIdInRoom(room, oldId, newId) {
    if (room.finishedPlayers.includes(oldId)) {
        room.finishedPlayers[room.finishedPlayers.indexOf(oldId)] = newId;
    }
    if (room.lastRoundRanks.includes(oldId)) {
        room.lastRoundRanks[room.lastRoundRanks.indexOf(oldId)] = newId;
    }
    if (room.center && room.center.ownerId === oldId) room.center.ownerId = newId;
    if (room.votes) {
        if (room.votes.keep.includes(oldId)) room.votes.keep[room.votes.keep.indexOf(oldId)] = newId;
        if (room.votes.lobby.includes(oldId)) room.votes.lobby[room.votes.lobby.indexOf(oldId)] = newId;
    }
    if (room.readyPlayers && room.readyPlayers.includes(oldId)) {
        room.readyPlayers[room.readyPlayers.indexOf(oldId)] = newId;
    }
    if (room.seonDraws) {
        Object.keys(room.seonDraws).forEach(uid => {
            if (room.seonDraws[uid] && room.seonDraws[uid].id === oldId) {
                room.seonDraws[uid].id = newId;
            }
        });
    }
}

io.on('connection', (socket) => {
    
    function handlePlayerExit() {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const pIdx = room.players.findIndex(p => p.id === socket.id);
            if (pIdx !== -1) {
                const pName = room.players[pIdx].name;
                const originalAvatar = room.players[pIdx].avatar;
                const uid = room.players[pIdx].uid;
                socket.leave(roomId);

                if (room.status === 'playing' || room.status === 'tax_phase' || room.status === 'ended' || room.status === 'seon_drawing') {
                    io.to(roomId).emit('chatMsg', `⚠️ [${pName}] 님이 일시적으로 끊겼습니다. AI가 임시 대체합니다.`);
                    
                    let newAiId = `ai_replace_${Date.now()}`;
                    updatePlayerIdInRoom(room, socket.id, newAiId);
                    
                    room.players[pIdx].id = newAiId;
                    room.players[pIdx].isAI = true;
                    room.players[pIdx].originalName = pName;
                    room.players[pIdx].originalAvatar = originalAvatar;
                    room.players[pIdx].uid = uid;
                    room.players[pIdx].name = `🤖 AI (${pName} 대체)`;
                    room.players[pIdx].avatar = '🤖';
                    
                    if (!room.players.some(p => p.isHost && !p.isAI)) {
                        let newHost = room.players.find(p => !p.isAI);
                        if (newHost) newHost.isHost = true;
                    }

                    if (room.pendingRevolution && room.pendingRevolution.playerId === newAiId) {
                        let isGrand = room.pendingRevolution.isGrand;
                        let p = room.players[pIdx];
                        delete room.pendingRevolution;
                        triggerRevolution(roomId, room, p, isGrand);
                    }

                    if (room.status === 'playing') broadcastGameState(roomId, room);
                    if (room.status === 'ended') {
                        if (room.votes) io.to(roomId).emit('voteStatusUpdated', { votes: room.votes, playersData: room.players });
                    }
                } else {
                    room.players.splice(pIdx, 1);
                    if (room.readyPlayers.includes(socket.id)) room.readyPlayers = room.readyPlayers.filter(id => id !== socket.id);
                    
                    if (room.players.filter(p => !p.isAI).length === 0) {
                        delete rooms[roomId];
                    } else {
                        if (!room.players.some(p => p.isHost)) {
                            let newHost = room.players.find(p => !p.isAI);
                            if (newHost) newHost.isHost = true;
                        }
                        io.to(roomId).emit('roomUpdated', { roomId: roomId, players: room.players.filter(p => !p.isAI), readyPlayers: room.readyPlayers, betAmount: room.betAmount, maxPlayers: room.maxPlayers });
                    }
                }
                break;
            }
        }
    }

    socket.on('disconnect', handlePlayerExit);
    socket.on('leaveRoom', handlePlayerExit);

    socket.on('createRoom', ({ playerName, maxPlayers, betAmount, avatar, uid }) => {
        uid = uid || `guest_${socket.id}`;
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[roomId] = {
            id: roomId, maxPlayers: parseInt(maxPlayers) || 4, betAmount: parseInt(betAmount) || 0,
            players: [{ id: socket.id, name: playerName, avatar: avatar || '🧑‍💻', uid: uid, hand: [], hasPassed: false, isHost: true, isAI: false }],
            currentTurnIdx: 0, center: { cards: [], count: 0, rank: 99, ownerId: null },
            status: 'lobby', finishedPlayers: [], lastRoundRanks: [], taxLogs: [],
            readyPlayers: [], transactions: [], votes: { keep: [], lobby: [] }
        };
        socket.join(roomId);
        socket.emit('roomCreated', { roomId, players: rooms[roomId].players, betAmount: rooms[roomId].betAmount, maxPlayers: rooms[roomId].maxPlayers });
    });

    socket.on('joinRoom', ({ roomId, playerName, avatar, uid }) => {
        uid = uid || `guest_${socket.id}`;
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMsg', '방을 찾을 수 없습니다.');

        if (room.status !== 'lobby') {
            let replaceIdx = room.players.findIndex(p => p.uid === uid);
            if (replaceIdx !== -1) {
                let oldId = room.players[replaceIdx].id;
                updatePlayerIdInRoom(room, oldId, socket.id);
                
                room.players[replaceIdx].id = socket.id;
                room.players[replaceIdx].name = playerName;
                room.players[replaceIdx].avatar = avatar || '🧑‍💻';
                room.players[replaceIdx].isAI = false;
                delete room.players[replaceIdx].originalName;
                delete room.players[replaceIdx].originalAvatar;

                socket.join(roomId);
                io.to(roomId).emit('chatMsg', `🎉 [${playerName}] 님이 동기화 재접속되었습니다!`);
                
                if (room.status === 'playing') {
                    socket.emit('gameStarted', {
                        players: room.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, cardCount: p.hand ? p.hand.length : 0, isAI: p.isAI })),
                        currentTurnId: room.players[room.currentTurnIdx].id, lastRoundRanks: room.lastRoundRanks
                    });
                    socket.emit('yourHand', room.players[replaceIdx].hand);
                }
                broadcastGameState(roomId, room);
                return;
            } else {
                return socket.emit('errorMsg', '이미 게임이 시작된 방입니다.');
            }
        }

        if (room.players.some(p => p.id === socket.id)) return;
        if (room.players.filter(p => !p.isAI).length >= room.maxPlayers) return socket.emit('errorMsg', `방이 가득 찼습니다. (최대 ${room.maxPlayers}인)`);

        room.players.push({ id: socket.id, name: playerName, avatar: avatar || '🧑‍💻', uid: uid, hand: [], hasPassed: false, isHost: false, isAI: false });
        socket.join(roomId);
        io.to(roomId).emit('roomUpdated', { roomId: roomId, players: room.players.filter(p => !p.isAI), readyPlayers: room.readyPlayers, betAmount: room.betAmount, maxPlayers: room.maxPlayers });
    });

    socket.on('requestRoomSync', ({ uid }) => {
        const room = getRoomBySocket(socket.id);
        if (!room) return;
        const player = room.players.find(p => p.uid === uid);
        if (!player) return;

        if (player.id !== socket.id) {
            updatePlayerIdInRoom(room, player.id, socket.id);
            player.id = socket.id;
            player.isAI = false;
            if(player.originalName) player.name = player.originalName;
            if(player.originalAvatar) player.avatar = player.originalAvatar;
            delete player.originalName; delete player.originalAvatar;
        }

        socket.emit('forceUIRenderSync', {
            status: room.status, roomId: room.id, betAmount: room.betAmount, maxPlayers: room.maxPlayers,
            players: room.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, cardCount: p.hand ? p.hand.length : 0, hasPassed: p.hasPassed, isEscaped: room.finishedPlayers.includes(p.id), isAI: p.isAI, uid: p.uid })),
            readyPlayers: room.readyPlayers, currentTurnId: room.players[room.currentTurnIdx] ? room.players[room.currentTurnIdx].id : null,
            center: room.center, finishedPlayers: room.finishedPlayers, lastRoundRanks: room.lastRoundRanks,
            hand: player.hand, balances: getCurrentRoomBalances(room), votes: room.votes, tiedPlayers: room.tiedPlayers || [], seonRound: room.seonRound
        });
        broadcastGameState(room.id, room);
    });

    socket.on('updateRoomSettings', ({ maxPlayers, betAmount }) => {
        const room = getRoomBySocket(socket.id);
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isHost) return;
        if (room.readyPlayers.length > 0) return;

        room.maxPlayers = parseInt(maxPlayers) || 4; room.betAmount = parseInt(betAmount) || 0;
        io.to(room.id).emit('roomUpdated', { roomId: room.id, players: room.players.filter(p => !p.isAI), readyPlayers: room.readyPlayers, betAmount: room.betAmount, maxPlayers: room.maxPlayers });
    });

    socket.on('toggleReady', () => {
        const room = getRoomBySocket(socket.id);
        if (!room) return;
        if (room.readyPlayers.includes(socket.id)) room.readyPlayers = room.readyPlayers.filter(id => id !== socket.id);
        else room.readyPlayers.push(socket.id);
        io.to(room.id).emit('roomUpdated', { roomId: room.id, players: room.players.filter(p => !p.isAI), readyPlayers: room.readyPlayers, betAmount: room.betAmount, maxPlayers: room.maxPlayers });
    });

    socket.on('sendEmote', (emote) => {
        const room = getRoomBySocket(socket.id);
        if (room) {
            const p = room.players.find(pl => pl.id === socket.id);
            if(p) io.to(room.id).emit('playerEmoted', { id: socket.id, name: p.name, emote });
        }
    });

    socket.on('startGame', () => {
        const room = getRoomBySocket(socket.id);
        if (!room) return;

        const humanPlayers = room.players.filter(p => !p.isAI);
        if (room.readyPlayers.length < humanPlayers.length - 1) return socket.emit('errorMsg', '모든 플레이어가 준비를 완료해야 합니다.');

        if (room.players.length < room.maxPlayers) {
            const botsNeeded = room.maxPlayers - room.players.length;
            for (let i = 1; i <= botsNeeded; i++) {
                room.players.push({ id: `ai_${i}_${Date.now()}`, name: `🤖 AI 봇 ${i}`, avatar: '🤖', uid: `bot_${i}_${Date.now()}`, hand: [], hasPassed: false, isHost: false, isAI: true });
            }
        }

        room.status = 'seon_drawing';
        room.seonDrawDeck = createDeck();
        room.seonDraws = {};
        room.tiedPlayers = [];
        room.seonRound = 1;

        room.players.forEach(p => {
            room.seonDraws[p.uid] = { id: p.id, name: p.name, history: [], isAI: p.isAI };
            if (p.isAI) setTimeout(() => { handleSeonPick(room.id, p.id); }, 1000 + Math.random() * 2000);
        });

        io.to(room.id).emit('seonDrawPhaseInit', { isTieBreaker: false, tiedPlayers: [] });
    });

    socket.on('pickSeonCard', () => {
        handleSeonPick(getRoomBySocket(socket.id)?.id, socket.id);
    });

    function handleSeonPick(roomId, playerId) {
        try {
            const room = rooms[roomId];
            if (!room || room.status !== 'seon_drawing') return;
            
            const player = room.players.find(p => p.id === playerId);
            if (!player) return;

            if (room.tiedPlayers.length > 0 && !room.tiedPlayers.includes(player.uid)) return;
            
            let pData = room.seonDraws[player.uid];
            if (!pData || pData.history.length >= room.seonRound) return;

            if(room.seonDrawDeck.length === 0) room.seonDrawDeck = createDeck();
            pData.history.push(room.seonDrawDeck.pop());

            let participants = room.tiedPlayers.length > 0 ? room.tiedPlayers : room.players.map(p => p.uid);
            let allDrawn = participants.every(uid => room.seonDraws[uid] && room.seonDraws[uid].history.length === room.seonRound);

            if (allDrawn) checkTiesAndProceed(roomId, room, participants);
            else {
                let drawnCount = participants.filter(uid => room.seonDraws[uid] && room.seonDraws[uid].history.length === room.seonRound).length;
                io.to(roomId).emit('seonPickProgress', { message: `⏳ 다른 플레이어 대기 중... (${drawnCount}/${participants.length})` });
            }
        } catch (e) { console.error("handleSeonPick Error:", e); }
    }

    function checkTiesAndProceed(roomId, room, participants) {
        try {
            let latestCardsMap = {};
            participants.forEach(uid => {
                if(!room.seonDraws[uid]) return;
                let hist = room.seonDraws[uid].history;
                let card = hist[hist.length - 1];
                if (!latestCardsMap[card]) latestCardsMap[card] = [];
                latestCardsMap[card].push(uid);
            });

            let currentRoundTies = [];
            for (let card in latestCardsMap) {
                if (latestCardsMap[card].length > 1) {
                    currentRoundTies.push(...latestCardsMap[card]);
                }
            }

            if (currentRoundTies.length > 0) {
                room.tiedPlayers = currentRoundTies;
                room.seonRound++;
                
                let drawResults = room.players.map(p => {
                    let d = room.seonDraws[p.uid];
                    return {
                        id: p.id, uid: p.uid, name: p.name,
                        card: d && d.history.length ? d.history[d.history.length - 1] : null
                    };
                }).filter(res => res.card !== null);

                io.to(roomId).emit('seonTieOccurred', { drawResults, tiedPlayers: currentRoundTies });

                setTimeout(() => {
                    if (!rooms[roomId] || rooms[roomId].status !== 'seon_drawing') return;
                    io.to(roomId).emit('seonDrawPhaseInit', { isTieBreaker: true, tiedPlayers: currentRoundTies });
                    
                    currentRoundTies.forEach(uid => {
                        let p = room.players.find(pl => pl.uid === uid);
                        if (p && p.isAI) {
                            setTimeout(() => handleSeonPick(roomId, p.id), 1000 + Math.random() * 1500);
                        }
                    });
                }, 4000);

            } else {
                let allUids = Object.keys(room.seonDraws);
                allUids.sort((a, b) => {
                    let histA = room.seonDraws[a] ? room.seonDraws[a].history : [];
                    let histB = room.seonDraws[b] ? room.seonDraws[b].history : [];
                    for (let i = 0; i < Math.max(histA.length, histB.length); i++) {
                        let valA = histA[i] !== undefined ? histA[i] : 999;
                        let valB = histB[i] !== undefined ? histB[i] : 999;
                        if (valA !== valB) return valA - valB;
                    }
                    return 0;
                });

                let newPlayers = [];
                allUids.forEach(uid => {
                    let p = room.players.find(p => String(p.uid) === String(uid));
                    if (p) newPlayers.push(p);
                });
                room.players = newPlayers;
                room.lastRoundRanks = room.players.map(p => p.id);

                let finalResults = room.players.map(p => {
                    let d = room.seonDraws[p.uid];
                    return {
                        id: p.id, uid: p.uid, name: p.name,
                        card: d && d.history ? d.history[0] : JOKER
                    };
                });

                let winnerPlayer = room.players[0];
                io.to(roomId).emit('seonDrawResults', { drawResults: finalResults, winnerId: winnerPlayer.id, winnerName: winnerPlayer.name });

                // ⭐️ 게임 멈춤 현상(서버 충돌) 완벽 방어
                setTimeout(() => {
                    try {
                        if (rooms[roomId] && rooms[roomId].status === 'seon_drawing') {
                            distributeCards(rooms[roomId]);
                            startNormalRound(roomId, rooms[roomId]);
                        }
                    } catch(err) {
                        console.error("Round Start Fallback Error:", err);
                    }
                }, 4500);
            }
        } catch(e) { console.error("checkTiesAndProceed Error:", e); }
    }

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

    socket.on('submitVote', (voteType) => {
        const room = getRoomBySocket(socket.id);
        if (!room || room.status !== 'ended') return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        room.votes = room.votes || { keep: [], lobby: [] };
        room.votes.keep = room.votes.keep.filter(id => id !== socket.id);
        room.votes.lobby = room.votes.lobby.filter(id => id !== socket.id);
        
        if (voteType === 'keep') room.votes.keep.push(socket.id);
        else if (voteType === 'lobby') room.votes.lobby.push(socket.id);

        io.to(room.id).emit('voteStatusUpdated', { votes: room.votes, playersData: room.players });

        const humanPlayers = room.players.filter(p => !p.isAI);
        
        if (room.votes.keep.length >= humanPlayers.length) {
            room.status = 'tax_phase';
            io.to(room.id).emit('hideResultScreen');
            
            room.lastRoundRanks = [...room.finishedPlayers];
            room.finishedPlayers = [];
            room.votes = { keep: [], lobby: [] };
            room.center = { cards: [], count: 0, rank: 99, ownerId: null };
            room.players.forEach(p => { p.hand = []; p.hasPassed = false; });
            
            let newPlayersOrder = [];
            room.lastRoundRanks.forEach(rId => {
                newPlayersOrder.push(room.players.find(p => p.id === rId));
            });
            room.players = newOrder = newPlayersOrder;

            distributeCards(room);
            executeTaxPhase(room.id, room);
        }
        else if (room.votes.lobby.length >= humanPlayers.length) {
            room.status = 'lobby';
            room.finishedPlayers = [];
            room.votes = { keep: [], lobby: [] };
            room.center = { cards: [], count: 0, rank: 99, ownerId: null };
            room.players.forEach(p => { p.hand = []; p.hasPassed = false; });
            io.to(room.id).emit('forceLobby', { players: room.players.filter(p=>!p.isAI) });
        }
    });

    socket.on('respondRevolution', ({ wantsRevolution }) => {
        const room = getRoomBySocket(socket.id);
        if (!room || room.status !== 'tax_phase' || !room.pendingRevolution) return;
        if (room.pendingRevolution.playerId !== socket.id) return;

        let isGrand = room.pendingRevolution.isGrand;
        let player = room.players.find(p => p.id === socket.id);
        delete room.pendingRevolution;

        if (wantsRevolution && player) {
            triggerRevolution(room.id, room, player, isGrand);
        } else {
            proceedWithTax(room.id, room);
        }
    });

    socket.on('submitTaxHand', ({ targetId, indices }) => {
        const room = getRoomBySocket(socket.id);
        if (!room) return;
        const giver = room.players.find(p => p.id === socket.id);
        const receiver = room.players.find(p => p.id === targetId);
        
        indices.sort((a,b) => b-a);
        let taxCards = indices.map(i => giver.hand[i]);
        
        if (taxCards.includes(JOKER)) {
            return socket.emit('errorMsg', '조커 카드는 세금으로 하사할 수 없습니다.');
        }

        taxCards = indices.map(i => giver.hand.splice(i, 1)[0]);
        receiver.hand.push(...taxCards);
        receiver.hand.sort((a,b) => a-b);
        
        room.taxLogs.push({ fromId: giver.id, toId: receiver.id, fromName: giver.name, toName: receiver.name, cards: taxCards });
        socket.emit('yourHand', giver.hand);
        
        let expectedLogs = 0; let total = room.players.length;
        if (total === 5) expectedLogs = 2;
        else if (total === 6 || total === 7) expectedLogs = 4;
        else if (total >= 8) expectedLogs = 6;

        if (room.taxLogs.length === expectedLogs) {
            io.to(room.id).emit('taxPhasePersonalResults', { taxLogs: room.taxLogs });
            setTimeout(() => {
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
    notifyTurn(roomId, nextTurnId);
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

    let delay = 1200;
    const activeHumans = room.players.filter(p => !p.isAI && !room.finishedPlayers.includes(p.id));
    if (activeHumans.length === 0) delay = 150;

    setTimeout(() => {
        try {
            if (!rooms[roomId] || rooms[roomId].status !== 'playing') return;
            let aiHand = player.hand;
            if (!aiHand || aiHand.length === 0) return; // ⭐️ 에러 방어
            
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
                let pIndices = bestRank !== -1 ? groups[bestRank] : (groups[JOKER] || []);
                if (pIndices.length === 0) return;
                
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
        } catch(e) { console.error("AI Turn Error:", e); }
    }, delay);
}

function getCurrentRoomBalances(room) {
    let balances = {};
    room.players.filter(p => !p.isAI).forEach(p => {
        if (p.uid && globalLedger[p.uid]) {
            balances[p.name] = globalLedger[p.uid].totalProfit;
        } else {
            balances[p.name] = 0;
        }
    });
    return balances;
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

            if (firstHuman.uid && lastHuman.uid) {
                if (!globalLedger[firstHuman.uid]) globalLedger[firstHuman.uid] = { totalProfit: 0, name: firstHuman.name };
                if (!globalLedger[lastHuman.uid]) globalLedger[lastHuman.uid] = { totalProfit: 0, name: lastHuman.name };
                
                globalLedger[firstHuman.uid].totalProfit += room.betAmount;
                globalLedger[firstHuman.uid].name = firstHuman.name;
                
                globalLedger[lastHuman.uid].totalProfit -= room.betAmount;
                globalLedger[lastHuman.uid].name = lastHuman.name;
                
                roundLog = { from: lastHuman.name, to: firstHuman.name, amount: room.betAmount };
                room.transactions.push(roundLog);
            }
        }

        let playersData = room.players.map(p => ({ id: p.id, name: p.name }));
        io.to(roomId).emit('gameOver', { finishedPlayers: room.finishedPlayers, playersData, balances: getCurrentRoomBalances(room), roundLog, votes: room.votes });
        return;
    }

    let activePlayers = room.players.filter(p => !p.hasPassed && !room.finishedPlayers.includes(p.id));
    if (activePlayers.length === 0 || (activePlayers.length === 1 && activePlayers[0].id === room.center.ownerId)) {
        clearTrickAndSetLead(roomId, room);
    } else {
        advanceTurn(room);
        notifyTurn(roomId, room.players[room.currentTurnIdx].id);
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
        notifyTurn(roomId, room.players[room.currentTurnIdx].id);
    }
    
    broadcastGameState(roomId, room);
    handleAITurnIfNeeded(roomId, room);
}

function distributeCards(room) {
    room.players.forEach(p => p.hand = []);
    let deck = createDeck();
    let p = 0;
    while (deck.length > 0) {
        if (!room.players[p]) break;
        room.players[p].hand.push(deck.pop());
        p = (p + 1) % room.players.length;
    }
    room.players.forEach(pl => pl.hand.sort((a, b) => a - b));
}

function broadcastGameState(roomId, room) {
    io.to(roomId).emit('gameStateUpdated', {
        center: room.center,
        currentTurnId: room.players[room.currentTurnIdx].id,
        finishedPlayers: room.finishedPlayers,
        players: room.players.map(p => ({
            id: p.id, name: p.name, avatar: p.avatar, cardCount: p.hand ? p.hand.length : 0, hasPassed: p.hasPassed, isEscaped: room.finishedPlayers.includes(p.id), isAI: p.isAI
        }))
    });
}

function executeTaxPhase(roomId, room) {
    room.status = 'tax_phase';

    if (room.players.length <= 4) {
        room.players.forEach(p => { if(!p.isAI) io.to(p.id).emit('yourHand', p.hand); });
        startNormalRound(roomId, room);
        return;
    }

    let revPlayer = null;
    let isGrand = false;

    for (let p of room.players) {
        if (p.hand.filter(c => c === JOKER).length === 2) {
            revPlayer = p;
            let lastRankId = room.lastRoundRanks[room.lastRoundRanks.length - 1];
            if (p.id === lastRankId) isGrand = true;
            break;
        }
    }

    if (revPlayer) {
        if (revPlayer.isAI) {
            triggerRevolution(roomId, room, revPlayer, isGrand);
        } else {
            io.to(roomId).emit('chatMsg', `👑 조커를 가진 누군가가 반란을 고민 중입니다...`);
            io.to(revPlayer.id).emit('promptRevolution', { isGrand });
            room.pendingRevolution = { playerId: revPlayer.id, isGrand: isGrand };
        }
    } else {
        proceedWithTax(roomId, room);
    }
}

function triggerRevolution(roomId, room, revPlayer, isGrand) {
    if (isGrand) {
        room.lastRoundRanks.reverse();
        let newOrder = [];
        room.lastRoundRanks.forEach(rId => newOrder.push(room.players.find(p=>p.id===rId)));
        room.players = newOrder;
        io.to(roomId).emit('revolutionAlert', { type: 'grand', playerName: revPlayer.name });
    } else {
        io.to(roomId).emit('revolutionAlert', { type: 'normal', playerName: revPlayer.name });
    }

    setTimeout(() => {
        room.players.forEach(p => p.hand.sort((a,b)=>a-b));
        room.players.forEach(p => { if(!p.isAI) io.to(p.id).emit('yourHand', p.hand); });
        startNormalRound(roomId, room);
    }, 7000);
}

function proceedWithTax(roomId, room) {
    let total = room.players.length; let taxRules = []; room.taxLogs = [];
    
    if (total <= 4) taxRules = [];
    else if (total === 5) taxRules.push({ highRank: 0, lowRank: total - 1, count: 1 });
    else if (total === 6 || total === 7) { taxRules.push({ highRank: 0, lowRank: total - 1, count: 2 }); taxRules.push({ highRank: 1, lowRank: total - 2, count: 1 }); }
    else if (total >= 8) { taxRules.push({ highRank: 0, lowRank: total - 1, count: 3 }); taxRules.push({ highRank: 1, lowRank: total - 2, count: 2 }); taxRules.push({ highRank: 2, lowRank: total - 3, count: 1 }); }

    if (taxRules.length === 0) {
        room.players.forEach(p => { if(!p.isAI) io.to(p.id).emit('yourHand', p.hand); });
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
        highPlayer.hand.sort((a,b)=>a-b);
        room.taxLogs.push({ fromId: lowPlayer.id, toId: highPlayer.id, fromName: lowPlayer.name, toName: highPlayer.name, cards: bestCards });
    });

    room.players.forEach(p => p.hand.sort((a,b)=>a-b));
    room.players.forEach(p => { if(!p.isAI) io.to(p.id).emit('yourHand', p.hand); });

    taxRules.forEach(rule => {
        let hId = room.lastRoundRanks[rule.highRank]; let lId = room.lastRoundRanks[rule.lowRank]; let count = rule.count;
        let lowPlayer = room.players.find(p => p.id === lId); let highPlayer = room.players.find(p => p.id === hId);

        if (highPlayer.isAI) {
            let aiNonJokers = highPlayer.hand.filter(c => c !== JOKER).sort((a,b)=>a-b);
            let worstCards = aiNonJokers.slice(aiNonJokers.length - count, aiNonJokers.length);
            
            worstCards.forEach(c => {
                let idx = highPlayer.hand.lastIndexOf(c);
                if (idx !== -1) highPlayer.hand.splice(idx, 1);
            });
            
            lowPlayer.hand.push(...worstCards);
            lowPlayer.hand.sort((a,b)=>a-b);
            room.taxLogs.push({ fromId: highPlayer.id, toId: lowPlayer.id, fromName: highPlayer.name, toName: lowPlayer.name, cards: worstCards });
        } else {
            humanTaxWaiting = true;
            let log = room.taxLogs.find(l => l.toId === highPlayer.id && l.fromId === lowPlayer.id);
            io.to(hId).emit('taxReceived', { cards: log.cards, count, targetName: lowPlayer.name, targetId: lId });
        }
    });

    if (!humanTaxWaiting) {
        io.to(roomId).emit('taxPhaseWaiting', { taxLogs: room.taxLogs });
        io.to(roomId).emit('taxPhasePersonalResults', { taxLogs: room.taxLogs });
        setTimeout(() => {
            room.players.forEach(p => { if(!p.isAI) io.to(p.id).emit('yourHand', p.hand); });
            startNormalRound(roomId, room);
        }, 4000);
    } else {
        io.to(roomId).emit('taxPhaseWaiting', { taxLogs: room.taxLogs });
    }
}

function startNormalRound(roomId, room) {
    room.status = 'playing';
    room.center = { cards: [], count: 0, rank: 99, ownerId: null };
    room.players.forEach(p => p.hand.sort((a,b)=>a-b));
    room.currentTurnIdx = 0;
    
    io.to(roomId).emit('gameStarted', {
        players: room.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, cardCount: p.hand ? p.hand.length : 0, isAI: p.isAI })),
        currentTurnId: room.players[0].id,
        lastRoundRanks: room.lastRoundRanks
    });

    room.players.forEach(p => { if (!p.isAI) io.to(p.id).emit('yourHand', p.hand); });
    notifyTurn(roomId, room.players[0].id);
    handleAITurnIfNeeded(roomId, room);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`서버 작동 포트: ${PORT}`); });
