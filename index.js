
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3001;

const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  if (rooms.has(code)) return generateRoomCode();
  return code;
}

function cleanupRooms() {
  const now = Date.now();
  const twoHours = 2 * 60 * 60 * 1000;
  for (const [code, room] of rooms.entries()) {
    if (now - room.createdAt > twoHours) {
      rooms.delete(code);
      console.log(`Cleaned up room ${code}`);
    }
  }
}

setInterval(cleanupRooms, 30 * 60 * 1000);

const io = new Server(PORT, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

console.log(`🔥 Family Smokehouse server running on port ${PORT}`);

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('create_room', (data, callback) => {
    const roomCode = generateRoomCode();
    const hostPlayer = {
      id: data.playerId,
      socketId: socket.id,
      name: data.playerName,
      role: null,
      isReady: false,
      isHost: true,
      isAI: false,
      score: 0,
    };
    const room = {
      code: roomCode,
      hostSocketId: socket.id,
      businessType: data.businessType,
      players: [hostPlayer],
      phase: 'lobby',
      gameState: null,
      createdAt: Date.now(),
    };
    rooms.set(roomCode, room);
    socket.join(roomCode);
    console.log(`Room ${roomCode} created by ${data.playerName}`);
    callback({ success: true, roomCode, players: room.players });
  });

  socket.on('join_room', (data, callback) => {
    const roomCode = data.roomCode.toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return callback({ success: false, error: 'Room not found' });
    if (room.phase !== 'lobby') return callback({ success: false, error: 'Game already in progress' });
    if (room.players.length >= 5) return callback({ success: false, error: 'Room is full' });

    const existingPlayer = room.players.find(p => p.id === data.playerId);
    if (existingPlayer) {
      existingPlayer.socketId = socket.id;
      socket.join(roomCode);
      callback({ success: true, roomCode, players: room.players, businessType: room.businessType });
      io.to(roomCode).emit('players_updated', room.players);
      return;
    }

    const newPlayer = {
      id: data.playerId,
      socketId: socket.id,
      name: data.playerName,
      role: null,
      isReady: false,
      isHost: false,
      isAI: false,
      score: 0,
    };
    room.players.push(newPlayer);
    socket.join(roomCode);
    console.log(`${data.playerName} joined room ${roomCode}`);
    callback({ success: true, roomCode, players: room.players, businessType: room.businessType });
    io.to(roomCode).emit('players_updated', room.players);
    io.to(roomCode).emit('player_joined', { player: newPlayer });
  });

  socket.on('select_role', (data) => {
    const room = rooms.get(data.roomCode);
    if (!room) return;
    const player = room.players.find(p => p.id === data.playerId);
    if (!player) return;
    const roleTaken = room.players.some(p => p.role === data.role && p.id !== data.playerId);
    if (roleTaken) return;
    player.role = data.role;
    player.isReady = false;
    io.to(data.roomCode).emit('players_updated', room.players);
  });

  socket.on('set_ready', (data) => {
    const room = rooms.get(data.roomCode);
    if (!room) return;
    const player = room.players.find(p => p.id === data.playerId);
    if (!player || !player.role) return;
    player.isReady = data.ready;
    io.to(data.roomCode).emit('players_updated', room.players);
  });

  socket.on('add_ai_player', (data) => {
    const room = rooms.get(data.roomCode);
    if (!room) return;
    if (room.hostSocketId !== socket.id) return;
    const roleTaken = room.players.some(p => p.role === data.role);
    if (roleTaken) return;
    const aiPlayer = {
      id: `ai-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      socketId: '',
      name: data.aiName,
      role: data.role,
      isReady: true,
      isHost: false,
      isAI: true,
      score: 0,
    };
    room.players.push(aiPlayer);
    io.to(data.roomCode).emit('players_updated', room.players);
  });

  socket.on('remove_player', (data) => {
    const room = rooms.get(data.roomCode);
    if (!room) return;
    const requester = room.players.find(p => p.socketId === socket.id);
    if (!requester) return;
    if (data.playerId !== requester.id && !requester.isHost) return;
    room.players = room.players.filter(p => p.id !== data.playerId);
    io.to(data.roomCode).emit('players_updated', room.players);
  });

  socket.on('start_game', (data) => {
    const room = rooms.get(data.roomCode);
    if (!room) return;
    if (room.hostSocketId !== socket.id) return;
    const allReady = room.players.every(p => p.isReady);
    if (!allReady) return;
    room.phase = 'playing';
    room.gameState = data.initialState;
    io.to(data.roomCode).emit('game_started', { gameState: room.gameState });
    console.log(`Game started in room ${data.roomCode}`);
  });

  socket.on('sync_game_state', (data) => {
    const room = rooms.get(data.roomCode);
    if (!room) return;
    if (room.hostSocketId !== socket.id) return;
    room.gameState = data.gameState;
    socket.to(data.roomCode).emit('game_state_updated', room.gameState);
  });

  socket.on('player_action', (data) => {
    const room = rooms.get(data.roomCode);
    if (!room) return;
    io.to(room.hostSocketId).emit('player_action_received', {
      playerId: room.players.find(p => p.socketId === socket.id)?.id,
      action: data.action,
    });
  });

  socket.on('end_game', (data) => {
    const room = rooms.get(data.roomCode);
    if (!room) return;
    if (room.hostSocketId !== socket.id) return;
    room.phase = 'results';
    io.to(data.roomCode).emit('game_ended', data.results);
  });

  socket.on('leave_room', (data) => {
    const room = rooms.get(data.roomCode);
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;
    room.players = room.players.filter(p => p.socketId !== socket.id);
    socket.leave(data.roomCode);
    if (player.isHost) {
      const humanPlayers = room.players.filter(p => !p.isAI);
      if (humanPlayers.length > 0) {
        humanPlayers[0].isHost = true;
        room.hostSocketId = humanPlayers[0].socketId;
        io.to(data.roomCode).emit('host_changed', { newHostId: humanPlayers[0].id });
      } else {
        rooms.delete(data.roomCode);
        console.log(`Room ${data.roomCode} deleted (no human players)`);
        return;
      }
    }
    io.to(data.roomCode).emit('players_updated', room.players);
    io.to(data.roomCode).emit('player_left', { playerId: player.id, playerName: player.name });
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    for (const [roomCode, room] of rooms.entries()) {
      const player = room.players.find(p => p.socketId === socket.id);
      if (player) {
        player.socketId = '';
        if (room.phase === 'lobby') {
          setTimeout(() => {
            const currentRoom = rooms.get(roomCode);
            if (currentRoom) {
              const stillDisconnected = currentRoom.players.find(p => p.id === player.id && p.socketId === '');
              if (stillDisconnected && !stillDisconnected.isAI) {
                currentRoom.players = currentRoom.players.filter(p => p.id !== player.id);
                if (stillDisconnected.isHost) {
                  const humanPlayers = currentRoom.players.filter(p => !p.isAI);
                  if (humanPlayers.length > 0) {
                    humanPlayers[0].isHost = true;
                    currentRoom.hostSocketId = humanPlayers[0].socketId;
                  } else {
                    rooms.delete(roomCode);
                    return;
                  }
                }
                io.to(roomCode).emit('players_updated', currentRoom.players);
                io.to(roomCode).emit('player_left', { playerId: player.id, playerName: player.name });
              }
            }
          }, 30000);
        }
        io.to(roomCode).emit('player_disconnected', { playerId: player.id, playerName: player.name });
      }
    }
  });

  socket.on('ping', (callback) => {
    callback({ timestamp: Date.now() });
  });
});
