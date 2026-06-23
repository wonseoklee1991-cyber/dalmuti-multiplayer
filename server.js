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
                if (room.players.filter(p => !p.isAI).length === 0) {
                    delete rooms[roomId];
                } else {
                    if (!room.players.some(p => p.isHost)) {
                        const newHost = room.players.find(p => !p.isAI);
                        if (newHost) newHost.isHost = true;
                    }
                    if (room.status === 'lobby' || room.status === 'seon_drawing') {
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
            taxLogs: [],
            seonPickedData: {} // 유저들이 선택한 선 뽑기 임시 저장소
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

    // 🃏 방장이 시작을 누르면 유저들이 직접 카드를 뽑는 페이즈로 전환
    socket.on('startGame', () => {
        const room = getRoomBySocket(socket.id);
        if (!room) return socket.emit('errorMsg', '방 세션 오류');

        const humanPlayers = room.players.filter(p => !p.isAI);
        if (humanPlayers.length < 4) {
            const botsNeeded = 4 - humanPlayers.length;
            for (let i = 1; i <= botsNeeded; i++) {
                room.players.push({ id: `ai_${i}_${Date.now()}`, name: `🤖 AI 봇 ${i}`, hand: [], hasPassed: false, isHost: false, isAI: true });
            }
        }

        room.status = 'seon_drawing';
        room.seonPickedData = {};

        // 🤖 AI 봇들은 시작하자마자 무작위로 카드를 미리 골라둠
        room.players.forEach(p => {
            if (p.isAI) {
                room.seonPickedData[p.id] = { name: p.name, card: Math.floor(Math.random() * 12) + 1, isAI: true };
            }
        });

        // 클라이언트 전원에게 수동 카드 선택 대기창 오픈 브로드캐스트
        io.to(room.id).emit('seonDrawPhaseInit', { totalPlayers: room.players.length });
    });

    // 🃏 유저가 화면에서 특정 카드 번호를 터치했을 때 서버로 인입되는 이벤트
    socket.on('pickSeonCard', ({ cardIndex }) => {
        const room = getRoomBySocket(socket.id);
        if (!room || room.status !== 'seon_drawing') return;
        if (room.seonPickedData[socket.id]) return; // 이미 선택한 유저는 중복 불가

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        // 터치한 행위에 따라 난수 매핑 (1~12 대칭 분산 값 연산)
        const generatedCard = Math.floor(Math.random() * 12) + 1;
        room.seonPickedData[socket.id] = { name: player.name, card: generatedCard, isAI: false };

        // 현재 방 인원이 전부 카드를 골랐는지 체크
        if (Object.keys(room.seonPickedData).length === room.players.length) {
            // 결과 정렬 처리 (가장 작은 숫자가 선)
            let sortedResults = Object.keys(room.seonPickedData).map(id => ({
                id,
                name: room.seonPickedData[id].name,
                card: room.seonPickedData[id].card
            })).sort((a, b) => a.card - b.card);

            const winnerId = sortedResults[0].id;
            const winnerName = sortedResults[0].name;

            // 전원에게 뒤집기 연출 결과 데이터 전송
            io.to(room.id).emit('seonDrawResults', { drawResults: sortedResults, winnerId, winnerName });

            // 4초 후 본 게임 세션 체인 링크 작동
            setTimeout(() => {
                if (!rooms[room.id] || rooms[room.id].status !== 'seon_drawing') return;

                room.status = 'playing';
                room.finishedPlayers = [];
                room.center = { cards: [], count: 0, rank: 99, ownerId: null };
                room.players.forEach(p => { p.hand = []; p.hasPassed = false; });

                room.lastRoundRanks = room.players.map(p => p.id);
                distributeCards(room);

                // ⭐️ 중요: 선을 완벽하게 동기화 고정하기 위해 인덱스를 수학적으로 추적 후 대입
                const targetIdx = room.players.findIndex(p => p.id === winnerId);
                room.currentTurnIdx = targetIdx !== -1 ? targetIdx : 0;

                io.to(room.id).emit('gameStarted', {
                    players: room.players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length, isAI: p.isAI })),
                    currentTurnId: room.players[room.currentTurnIdx].id,
                    lastRoundRanks: room.lastRoundRanks
                });

                room.players.forEach(p => { if (!p.isAI) io.to(p.id).emit('yourHand', p.hand); });
                handleAITurnIfNeeded(room.id, room);
            }, 4500);
        } else {
            // 아직 다 안 골랐으면 현재까지 몇 명이 골랐는지 대기 스크린 업데이트
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
        
        // ⭐️ 손패 차감 반영 버그 해결: 카드를 내자마자 차감된 패 데이터를 해당 플레이어에게 즉시 재동기화 전송
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
        
        socket.emit('yourHand', giver.hand); // 세금 낸 후 손패 즉시 업데이트
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
        // ⭐️ 선(대달무티 등) 유저 턴 인덱스 고정 보장 패치 적용
        const targetIdx = room.players.findIndex(p => p.id === nextTurnId);
        room.currentTurnIdx = targetIdx !== -1 ? targetIdx : 0;
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
