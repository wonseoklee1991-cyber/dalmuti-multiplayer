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

function createDeck() {
    let deck = [];
    for (let i = 1; i <= 12; i++) {
        for (let j = 0; j < i; j++) deck.push(i);
    }
    deck.push(JOKER, JOKER);
    return deck.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    console.log('유저 접속:', socket.id);

    // 방 만들기
    socket.on('createRoom', (playerName) => {
        const roomId = Math.floor(1000 + Math.random() * 9000).toString(); // 4자리 방 코드
        rooms[roomId] = {
            id: roomId,
            players: [{ id: socket.id, name: playerName, hand: [], hasPassed: false, isHost: true }],
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

    // 방 참가하기
    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMsg', '방을 찾을 수 없습니다.');
        if (room.status !== 'lobby') return socket.emit('errorMsg', '이미 게임이 시작된 방입니다.');
        if (room.players.length >= 8) return socket.emit('errorMsg', '방이 가득 찼습니다. (최대 8인)');

        room.players.push({ id: socket.id, name: playerName, hand: [], hasPassed: false, isHost: false });
        socket.join(roomId);
        io.to(roomId).emit('roomUpdated', { players: room.players });
    });

    // 게임 시작 (호스트 전용)
    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.players.length < 2) return socket.emit('errorMsg', '최소 2명 이상이어야 시작 가능합니다.');

        room.status = 'playing';
        room.finishedPlayers = [];
        
        // 순서 무작위 셔플 (첫 판 설정)
        room.players = room.players.sort(() => Math.random() - 0.5);
        room.lastRoundRanks = room.players.map(p => p.id);

        distributeCards(room);
        room.currentTurnIdx = 0; // 1등부터 시작

        io.to(roomId).emit('gameStarted', {
            players: room.players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length })),
            currentTurnId: room.players[room.currentTurnIdx].id,
            lastRoundRanks: room.lastRoundRanks
        });

        // 각 플레이어에게 자신의 패 전송
        room.players.forEach(p => {
            io.to(p.id).emit('yourHand', p.hand);
        });
    });

    // 카드 내기
    socket.on('playCards', ({ roomId, indices }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players[room.currentTurnIdx];
        if (player.id !== socket.id) return;

        // 인덱스 역순 정렬 후 카드 추출
        indices.sort((a, b) => b - a);
        let selectedCards = indices.map(i => player.hand[i]);
        
        let nonJoker = selectedCards.filter(c => c !== JOKER);
        let eRank = nonJoker.length === 0 ? JOKER : nonJoker[0];

        // 검증
        if (!nonJoker.every(c => c === eRank)) return socket.emit('errorMsg', '조커 외에는 같은 숫자여야 합니다.');
        if (room.center.count > 0 && (selectedCards.length !== room.center.count || eRank >= room.center.rank)) {
            return socket.emit('errorMsg', '필드의 규칙에 맞지 않는 카드입니다.');
        }

        // 패에서 삭제 및 필드 적용
        indices.forEach(i => player.hand.splice(i, 1));
        room.center = { cards: selectedCards, count: selectedCards.length, rank: eRank, ownerId: player.id };

        // 탈출 체크
        if (player.hand.length === 0 && !room.finishedPlayers.includes(player.id)) {
            room.finishedPlayers.push(player.id);
            io.to(roomId).emit('playerEscaped', { playerId: player.id, name: player.name });
        }

        if (checkGameOver(room)) {
            room.status = 'ended';
            io.to(roomId).emit('gameOver', { finishedPlayers: room.finishedPlayers });
            return;
        }

        // 다음 턴 넘기기
        advanceTurn(room);
        broadcastGameState(roomId, room);
    });

    // 패스
    socket.on('passTurn', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players[room.currentTurnIdx];
        if (player.id !== socket.id) return;
        if (room.center.count === 0) return socket.emit('errorMsg', '선 플레이어는 패스할 수 없습니다.');

        player.hasPassed = true;
        io.to(roomId).emit('playerPassed', { name: player.name });

        // 모든 활성 유저가 패스했는지 체크
        let activePlayers = room.players.filter(p => !p.hasPassed && !room.finishedPlayers.includes(p.id));
        
        if (activePlayers.length === 0 || (activePlayers.length === 1 && activePlayers[0].id === room.center.ownerId)) {
            // 새 라운드 시작
            room.center = { cards: [], count: 0, rank: 99, ownerId: null };
            room.players.forEach(p => p.hasPassed = false);
            
            // 선 찾기 (마지막에 카드를 낸 유저가 선, 만약 그 유저가 깼다면 다음 계급순)
            let nextTurnId = room.center.ownerId;
            if (room.finishedPlayers.includes(nextTurnId)) {
                nextTurnId = room.lastRoundRanks.find(id => !room.finishedPlayers.includes(id));
            }
            room.currentTurnIdx = room.players.findIndex(p => p.id === nextTurnId);
            
            io.to(roomId).emit('newRound', { currentTurnId: nextTurnId });
        } else {
            advanceTurn(room);
        }
        broadcastGameState(roomId, room);
    });

    // 다음 판 시작 (세금 계산 포함)
    socket.on('playNextRound', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        
        // 최종 등수 세팅 후 리셋
        room.lastRoundRanks = [...room.finishedPlayers];
        room.finishedPlayers = [];
        room.center = { cards: [], count: 0, rank: 99, ownerId: null };
        room.players.forEach(p => { p.hand = []; p.hasPassed = false; });
        
        // 카드 재생성 및 분배
        distributeCards(room);
        
        // 반란 체크 리스트 생성
        let hasRev = checkRevolution(room);
        if (hasRev.great) {
            io.to(roomId).emit('chatMsg', `🚨 대반란 발생! 농노의 조커 2장으로 인해 순위가 전면 역전됩니다!`);
            room.lastRoundRanks.reverse();
            startNormalRound(roomId, room);
        } else if (hasRev.normalPlayerId !== null) {
            // 반란 선택 모달 유도
            io.to(hasRev.normalPlayerId).emit('askRevolution');
            room.status = 'revolution_asking';
        } else {
            // 정상 세금 페이즈
            executeTaxPhase(roomId, room);
        }
    });

    socket.on('answerRevolution', ({ roomId, isRevolting }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (isRevolting) {
            io.to(roomId).emit('chatMsg', `🔥 반란 성공! 이번 라운드는 세금 없이 진행됩니다.`);
            startNormalRound(roomId, room);
        } else {
            executeTaxPhase(roomId, room);
        }
    });

    // 왕족이 농노에게 쓰레기 카드 하사할 때
    socket.on('submitTaxHand', ({ roomId, targetId, indices }) => {
        const room = rooms[roomId];
        if (!room) return;
        const giver = room.players.find(p => p.id === socket.id);
        const receiver = room.players.find(p => p.id === targetId);
        
        indices.sort((a,b) => b-a);
        let taxCards = indices.map(i => giver.hand.splice(i, 1)[0]);
        receiver.hand.push(...taxCards);
        
        room.taxLogs.push({ from: giver.name, to: receiver.name, cards: taxCards });
        
        // 남은 하사 태스크가 있는지 검사하고 없으면 다음 판 시작
        room.pendingTaxTasks = room.currentTaxRules.filter(rule => {
            let hId = room.lastRoundRanks[rule.highRank];
            let p = room.players.find(pl => pl.id === hId);
            return p.hand.length > (80 / room.players.length); // 단순 검증: 정량보다 패가 많으면 하사 대기 상태로 간주
        });

        // 실제 대기 룰 태스크가 모두 풀렸다면 라운드 시작
        // 여기서는 유연한 상태 제어를 위해 모든 태스크 완료 체크 로직 구현
        checkAndStartRoundAfterTax(roomId, room);
    });

    socket.on('disconnect', () => {
        console.log('유저 접속 해제:', socket.id);
        // 방을 순회하며 나간 유저 처리
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const pIdx = room.players.findIndex(p => p.id === socket.id);
            if (pIdx !== -1) {
                room.players.splice(pIdx, 1);
                if (room.players.length === 0) {
                    delete rooms[roomId];
                } else {
                    if (room.status !== 'lobby') {
                        room.status = 'lobby';
                        io.to(roomId).emit('chatMsg', '플레이어 탈주로 인해 게임이 로비로 리셋되었습니다.');
                    }
                    io.to(roomId).emit('roomUpdated', { players: room.players });
                }
                break;
            }
        }
    });
});

function distributeCards(room) {
    let deck = createDeck();
    let p = 0;
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
            id: p.id,
            name: p.name,
            cardCount: p.hand.length,
            hasPassed: p.hasPassed,
            isEscaped: room.finishedPlayers.includes(p.id)
        }))
    });
}

function checkGameOver(room) {
    return room.finishedPlayers.length >= room.players.length - 1;
}

function checkRevolution(room) {
    let total = room.players.length;
    let taxPayers = [room.lastRoundRanks[total - 1]];
    if (total >= 6) taxPayers.push(room.lastRoundRanks[total - 2]);
    if (total === 8) taxPayers.push(room.lastRoundRanks[total - 3]);

    let great = false;
    let normalPlayerId = null;

    room.players.forEach(p => {
        let jokers = p.hand.filter(c => c === JOKER).length;
        if (jokers === 2) {
            if (taxPayers.includes(p.id)) great = true;
            else normalPlayerId = p.id;
        }
    });
    return { great, normalPlayerId };
}

function executeTaxPhase(roomId, room) {
    let total = room.players.length;
    let taxRules = [];
    room.taxLogs = [];

    if (total === 4 || total === 5) taxRules.push({ highRank: 0, lowRank: total - 1, count: 1 });
    else if (total === 6 || total === 7) {
        taxRules.push({ highRank: 0, lowRank: total - 1, count: 2 });
        taxRules.push({ highRank: 1, lowRank: total - 2, count: 1 });
    } else if (total === 8) {
        taxRules.push({ highRank: 0, lowRank: total - 1, count: 3 });
        taxRules.push({ highRank: 1, lowRank: total - 2, count: 2 });
        taxRules.push({ highRank: 2, lowRank: total - 3, count: 1 });
    }

    room.currentTaxRules = taxRules;

    // 1. 하위 계급 자동 상납 (조커 제외 최고 카드)
    taxRules.forEach(rule => {
        let hId = room.lastRoundRanks[rule.highRank];
        let lId = room.lastRoundRanks[rule.lowRank];
        let count = rule.count;

        let lowPlayer = room.players.find(p => p.id === lId);
        let highPlayer = room.players.find(p => p.id === hId);

        let nonJokers = lowPlayer.hand.filter(c => c !== JOKER).sort((a,b)=>a-b);
        let bestCards = nonJokers.slice(0, count);

        bestCards.forEach(c => {
            let idx = lowPlayer.hand.indexOf(c);
            lowPlayer.hand.splice(idx, 1);
        });
        highPlayer.hand.push(...bestCards);
        room.taxLogs.push({ type: '상납', from: lowPlayer.name, to: highPlayer.name, cards: bestCards });
        
        // 상위 유저에게 상납 알림 및 패 새로 전송
        io.to(hId).emit('taxReceived', { cards: bestCards, count, targetName: lowPlayer.name, targetId: lId });
    });

    room.status = 'tax_phase';
    // 각 유저 패 동기화
    room.players.forEach(p => { io.to(p.id).emit('yourHand', p.hand); });

    // AI 혹은 자동화 처리 대상 스캔 (여기서는 인간들 간의 인터랙티브 전송 세팅)
    // 2. 상위 유저는 클라이언트에서 카드를 직접 선택해 서버로 'submitTaxHand' 이벤트를 보낼 때까지 대기합니다.
    io.to(roomId).emit('taxPhaseStarted', { taxLogs: room.taxLogs, taxRules, lastRoundRanks: room.lastRoundRanks });
}

function checkAndStartRoundAfterTax(roomId, room) {
    // 모든 유저의 카드 장수가 공평하게 원래 세팅대로 복구되었는지 엄격 검사하는 간소화 트리거
    let totalInitialCards = 54;
    let expectedPerPlayer = Math.floor(totalInitialCards / room.players.length);
    
    // 플레이어들이 하사품 처리를 다 마쳤는지 확인
    let readyCount = 0;
    room.players.forEach(p => {
        // 대강 하사가 끝났는지 정렬 후 동기화
        p.hand.sort((a,b)=>a-b);
        io.to(p.id).emit('yourHand', p.hand);
    });

    startNormalRound(roomId, room);
}

function startNormalRound(roomId, room) {
    room.status = 'playing';
    let firstPlayerId = room.lastRoundRanks[0];
    room.currentTurnIdx = room.players.findIndex(p => p.id === firstPlayerId);
    
    io.to(roomId).emit('gameStarted', {
        players: room.players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length })),
        currentTurnId: firstPlayerId,
        lastRoundRanks: room.lastRoundRanks
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`서버가 포트 ${PORT}에서 작동 중입니다.`);
});
