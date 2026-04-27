const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game Constants ───────────────────────────────────────────────────────────
const GAME_DURATION = 15 * 60; // 15 minutes in seconds
const MAX_PLAYERS = 6;
const REVENUE_TARGET = 800;
const MAX_FAILED_ORDERS = 8;
const STARTING_SATISFACTION = 100;
const MAX_VOTES = 2;

const ROLES = ['Head Chef', 'Sous Chef', 'Server', 'Cleaner', 'Manager', 'Saboteur'];
const FAKE_ROLES = ['Head Chef', 'Sous Chef', 'Server', 'Cleaner', 'Manager'];

const ROLE_BONUSES = {
  'Head Chef':  { desc: 'Cook & Bake actions are 30% faster for you.' },
  'Sous Chef':  { desc: 'Prep & Fix actions are 30% faster for you.' },
  'Server':     { desc: 'Serve actions are 30% faster for you.' },
  'Cleaner':    { desc: 'Clean actions are 30% faster for you.' },
  'Manager':    { desc: 'You can trigger a Team Boost to speed everyone up briefly.' },
  'Saboteur':   { desc: 'You have hidden sabotage actions. Blend in!' }
};

const DISHES = {
  Burger: {
    steps: ['Prep Bun', 'Cook Patty', 'Assemble', 'Serve'],
    reward: 80,
    baseTime: 90 // seconds patience
  },
  Pizza: {
    steps: ['Prep Dough', 'Add Toppings', 'Bake', 'Serve'],
    reward: 120,
    baseTime: 120
  },
  Salad: {
    steps: ['Chop Veg', 'Mix', 'Serve'],
    reward: 60,
    baseTime: 70
  }
};

// Action durations (ms)
const ACTION_DURATION = {
  'Prep Bun':    3000, 'Cook Patty':  4000, 'Assemble':    3000,
  'Prep Dough':  3000, 'Add Toppings':3000, 'Bake':        5000,
  'Chop Veg':    2500, 'Mix':         2000,
  'Serve':       2000, 'Clean':       3000, 'Fix':         3500,
  'Boost':       1000
};

// Role speed multipliers
function getSpeedMultiplier(role, action) {
  const a = action.toLowerCase();
  if (role === 'Head Chef' && (a.includes('cook') || a.includes('bake'))) return 0.7;
  if (role === 'Sous Chef'  && (a.includes('prep') || a.includes('fix') || a.includes('chop') || a.includes('mix'))) return 0.7;
  if (role === 'Server'     && a.includes('serve')) return 0.7;
  if (role === 'Cleaner'    && a.includes('clean')) return 0.7;
  return 1.0;
}

// ─── Room Storage ─────────────────────────────────────────────────────────────
const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function generateOrderId() {
  return 'ord_' + Math.random().toString(36).substr(2, 8);
}

function createRoom(hostId, hostName) {
  let code;
  do { code = generateRoomCode(); } while (rooms[code]);

  rooms[code] = {
    code,
    host: hostId,
    phase: 'lobby', // lobby | roleReveal | game | ended
    players: {
      [hostId]: {
        id: hostId, name: hostName, role: null, fakeRole: null,
        ready: false, ejected: false, busyUntil: 0, boostUntil: 0,
        sabotageCooldowns: {}
      }
    },
    game: null
  };
  return rooms[code];
}

function getRoom(code) { return rooms[code] || null; }

function assignRoles(room) {
  const playerIds = Object.keys(room.players);
  const shuffledRoles = [...ROLES].sort(() => Math.random() - 0.5);
  playerIds.forEach((id, i) => {
    const role = shuffledRoles[i];
    room.players[id].role = role;
    if (role === 'Saboteur') {
      const fakePool = FAKE_ROLES.filter(r => !playerIds.slice(0, i).some(pid => room.players[pid].role === r));
      room.players[id].fakeRole = fakePool[Math.floor(Math.random() * fakePool.length)] || 'Server';
    } else {
      room.players[id].fakeRole = role;
    }
  });
}

function initGame(room) {
  room.phase = 'game';
  room.game = {
    timer: GAME_DURATION,
    revenue: 0,
    revenueTarget: REVENUE_TARGET,
    satisfaction: STARTING_SATISFACTION,
    failedOrders: 0,
    orders: [],
    log: [],
    votesUsed: 0,
    activeVote: null,
    boostActive: false,
    boostEnd: 0,
    managerCooldown: 0,
    orderSpawnInterval: 20, // seconds between spawns
    lastOrderSpawn: 0,
    difficulty: 1,
    tickInterval: null
  };
  addLog(room, '🍳 Service has begun! Good luck team!');
  spawnOrder(room);
}

function addLog(room, msg) {
  room.game.log.unshift({ msg, time: room.game.timer });
  if (room.game.log.length > 30) room.game.log.pop();
}

function spawnOrder(room) {
  const g = room.game;
  const dishNames = Object.keys(DISHES);
  const dishName = dishNames[Math.floor(Math.random() * dishNames.length)];
  const dish = DISHES[dishName];
  const patienceReduction = Math.max(0.5, 1 - (g.difficulty - 1) * 0.1);
  const order = {
    id: generateOrderId(),
    dish: dishName,
    steps: [...dish.steps],
    currentStepIndex: 0,
    reward: dish.reward,
    patience: Math.floor(dish.baseTime * patienceReduction),
    maxPatience: Math.floor(dish.baseTime * patienceReduction),
    status: 'active', // active | done | failed
    lockedBy: null,   // playerId doing current step
    lockExpires: 0,
    slowed: false,
    slowedUntil: 0,
    hidden: false,
    hiddenUntil: 0
  };
  g.orders.push(order);
  addLog(room, `📋 New order: ${dishName}!`);
}

function getRoomState(room) {
  const g = room.game;
  const playersArr = Object.values(room.players).map(p => ({
    id: p.id, name: p.name, fakeRole: p.fakeRole, ejected: p.ejected,
    busy: Date.now() < p.busyUntil
  }));
  return {
    code: room.code,
    phase: room.phase,
    host: room.host,
    players: playersArr,
    game: g ? {
      timer: g.timer,
      revenue: g.revenue,
      revenueTarget: g.revenueTarget,
      satisfaction: g.satisfaction,
      failedOrders: g.failedOrders,
      orders: g.orders.filter(o => o.status !== 'done').map(o => ({
        id: o.id, dish: o.dish,
        currentStep: o.steps[o.currentStepIndex] || 'Done',
        currentStepIndex: o.currentStepIndex,
        totalSteps: o.steps.length,
        patience: Math.round(o.patience),
        maxPatience: o.maxPatience,
        status: o.status,
        lockedBy: o.lockedBy,
        hidden: o.hidden && o.hiddenUntil > Date.now()
      })),
      log: g.log.slice(0, 15),
      votesUsed: g.votesUsed,
      activeVote: g.activeVote,
      boostActive: g.boostActive && g.boostEnd > Date.now(),
      managerOnCooldown: g.managerCooldown > Date.now()
    } : null
  };
}

function getPrivateState(room, playerId) {
  const p = room.players[playerId];
  if (!p) return {};
  const pub = getRoomState(room);
  pub.myRole = p.role;
  pub.myFakeRole = p.fakeRole;
  pub.myEjected = p.ejected;
  pub.myBusy = Date.now() < p.busyUntil;
  pub.myBusyUntil = p.busyUntil;
  pub.mySabotageCooldowns = p.sabotageCooldowns;
  return pub;
}

function broadcastRoom(room) {
  Object.keys(room.players).forEach(pid => {
    const sock = io.sockets.sockets.get(pid);
    if (sock) sock.emit('gameState', getPrivateState(room, pid));
  });
}

function checkEndConditions(room) {
  const g = room.game;
  if (!g || room.phase !== 'game') return;

  let ended = false;
  let teamWin = false;
  let reason = '';

  const saboteur = Object.values(room.players).find(p => p.role === 'Saboteur' && !p.ejected);

  if (g.satisfaction <= 0) {
    ended = true; teamWin = false; reason = 'Customer satisfaction reached zero!';
  } else if (g.failedOrders >= MAX_FAILED_ORDERS) {
    ended = true; teamWin = false; reason = `Too many failed orders (${MAX_FAILED_ORDERS})!`;
  } else if (g.timer <= 0) {
    ended = true;
    if (g.revenue >= g.revenueTarget) {
      if (!saboteur) { teamWin = true; reason = 'Service complete! Revenue target reached and saboteur was caught!'; }
      else { teamWin = false; reason = 'Time\'s up! Revenue reached but saboteur survived!'; }
    } else {
      teamWin = false; reason = 'Time\'s up! Revenue target not met.';
    }
  }

  if (ended) endGame(room, teamWin, reason);
}

function endGame(room, teamWin, reason) {
  room.phase = 'ended';
  if (room.game.tickInterval) clearInterval(room.game.tickInterval);
  const saboteurPlayer = Object.values(room.players).find(p => p.role === 'Saboteur');
  const endData = {
    teamWin,
    reason,
    saboteurName: saboteurPlayer ? saboteurPlayer.name : 'Unknown',
    revenue: room.game.revenue,
    revenueTarget: room.game.revenueTarget,
    failedOrders: room.game.failedOrders,
    satisfaction: room.game.satisfaction,
    players: Object.values(room.players).map(p => ({ name: p.name, role: p.role, ejected: p.ejected }))
  };
  io.to(room.code).emit('gameEnded', endData);
}

// ─── Game Tick ────────────────────────────────────────────────────────────────
function startGameTick(room) {
  const TICK_MS = 1000;
  room.game.tickInterval = setInterval(() => {
    if (room.phase !== 'game') { clearInterval(room.game.tickInterval); return; }
    const g = room.game;
    const now = Date.now();

    if (!g.activeVote) {
      g.timer = Math.max(0, g.timer - 1);
      g.difficulty = 1 + (GAME_DURATION - g.timer) / GAME_DURATION * 2;

      // Satisfaction slow drain
      if (Math.random() < 0.05) {
        g.satisfaction = Math.max(0, g.satisfaction - 1);
      }

      // Order patience drain
      g.orders.forEach(order => {
        if (order.status !== 'active') return;
        if (order.hidden && order.hiddenUntil > now) return;
        const rate = order.slowed && order.slowedUntil > now ? 0.5 : 1;
        order.patience -= rate;
        if (order.patience <= 0) {
          order.status = 'failed';
          order.lockedBy = null;
          g.failedOrders++;
          g.satisfaction = Math.max(0, g.satisfaction - 8);
          addLog(room, `❌ Order failed: ${order.dish}! Customers are angry.`);
        }
      });

      // Unlock expired locks
      g.orders.forEach(order => {
        if (order.lockedBy && order.lockExpires < now) {
          order.lockedBy = null;
        }
      });

      // Spawn new orders
      g.lastOrderSpawn++;
      const spawnRate = Math.max(8, g.orderSpawnInterval - Math.floor(g.difficulty * 3));
      const activeOrders = g.orders.filter(o => o.status === 'active').length;
      if (g.lastOrderSpawn >= spawnRate && activeOrders < 5) {
        g.lastOrderSpawn = 0;
        spawnOrder(room);
      }
    }

    broadcastRoom(room);
    checkEndConditions(room);
  }, TICK_MS);
}

// ─── Socket.IO Events ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('createRoom', ({ name }) => {
    if (!name || name.trim().length < 1) return socket.emit('error', 'Name required');
    const room = createRoom(socket.id, name.trim().slice(0, 20));
    socket.join(room.code);
    socket.emit('roomCreated', { code: room.code });
    socket.emit('gameState', getPrivateState(room, socket.id));
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = getRoom(code?.toUpperCase());
    if (!room) return socket.emit('error', 'Room not found');
    if (room.phase !== 'lobby') return socket.emit('error', 'Game already started');
    if (Object.keys(room.players).length >= MAX_PLAYERS) return socket.emit('error', 'Room is full');
    if (!name || name.trim().length < 1) return socket.emit('error', 'Name required');

    room.players[socket.id] = {
      id: socket.id, name: name.trim().slice(0, 20),
      role: null, fakeRole: null, ready: false, ejected: false,
      busyUntil: 0, sabotageCooldowns: {}
    };
    socket.join(code.toUpperCase());
    io.to(room.code).emit('playerJoined', { name: name.trim() });
    broadcastRoom(room);
  });

  socket.on('startGame', ({ code }) => {
    const room = getRoom(code);
    if (!room) return socket.emit('error', 'Room not found');
    if (room.host !== socket.id) return socket.emit('error', 'Only the host can start');
    if (room.phase !== 'lobby') return socket.emit('error', 'Game already started');
    if (Object.keys(room.players).length < MAX_PLAYERS) {
      return socket.emit('error', `Need ${MAX_PLAYERS} players (have ${Object.keys(room.players).length})`);
    }

    assignRoles(room);
    room.phase = 'roleReveal';

    // Send each player their private role
    Object.values(room.players).forEach(p => {
      const sock = io.sockets.sockets.get(p.id);
      if (sock) {
        sock.emit('roleReveal', {
          role: p.role,
          fakeRole: p.fakeRole,
          bonus: ROLE_BONUSES[p.role].desc
        });
      }
    });
  });

  socket.on('readyToPlay', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'roleReveal') return;
    const player = room.players[socket.id];
    if (!player) return;
    player.ready = true;

    const allReady = Object.values(room.players).every(p => p.ready);
    if (allReady) {
      initGame(room);
      startGameTick(room);
      broadcastRoom(room);
    }
  });

  socket.on('doTask', ({ code, orderId, action }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'game') return;
    const player = room.players[socket.id];
    if (!player || player.ejected) return;
    const g = room.game;
    const now = Date.now();
    if (now < player.busyUntil) return socket.emit('error', 'You are busy');

    const order = g.orders.find(o => o.id === orderId && o.status === 'active');
    if (!order) return socket.emit('error', 'Order not found');
    if (order.hidden && order.hiddenUntil > now) return socket.emit('error', 'Ingredient missing!');

    const expectedStep = order.steps[order.currentStepIndex];
    if (action !== expectedStep) return socket.emit('error', `Wrong step. Need: ${expectedStep}`);

    // Check if locked by someone else
    if (order.lockedBy && order.lockedBy !== socket.id && order.lockExpires > now) {
      return socket.emit('error', 'Another player is on this step');
    }

    let duration = ACTION_DURATION[action] || 3000;
    const mult = getSpeedMultiplier(player.role, action);

    // Apply boost
    if (g.boostActive && g.boostEnd > now) duration *= 0.7;
    duration *= mult;

    order.lockedBy = socket.id;
    order.lockExpires = now + duration + 500;
    player.busyUntil = now + duration;

    socket.emit('taskStarted', { orderId, action, duration });

    setTimeout(() => {
      // Re-validate
      if (room.phase !== 'game') return;
      if (order.status !== 'active') return;
      if (order.lockedBy !== socket.id) return;

      order.currentStepIndex++;
      order.lockedBy = null;
      order.lockExpires = 0;

      if (order.currentStepIndex >= order.steps.length) {
        order.status = 'done';
        g.revenue += order.reward;
        g.satisfaction = Math.min(100, g.satisfaction + 3);
        addLog(room, `✅ ${order.dish} served! +$${order.reward}`);
      } else {
        addLog(room, `👍 ${player.name} completed: ${action}`);
      }
      broadcastRoom(room);
    }, duration);
  });

  socket.on('doClean', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'game') return;
    const player = room.players[socket.id];
    if (!player || player.ejected) return;
    const now = Date.now();
    if (now < player.busyUntil) return socket.emit('error', 'You are busy');

    let duration = ACTION_DURATION['Clean'];
    const mult = getSpeedMultiplier(player.role, 'clean');
    duration *= mult;
    if (room.game.boostActive && room.game.boostEnd > now) duration *= 0.7;

    player.busyUntil = now + duration;
    socket.emit('taskStarted', { orderId: null, action: 'Clean', duration });

    setTimeout(() => {
      if (room.phase !== 'game') return;
      room.game.satisfaction = Math.min(100, room.game.satisfaction + 2);
      addLog(room, `🧹 ${player.name} cleaned up!`);
      broadcastRoom(room);
    }, duration);
  });

  socket.on('doManagerBoost', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'game') return;
    const player = room.players[socket.id];
    if (!player || player.ejected) return;
    if (player.role !== 'Manager') return socket.emit('error', 'Only Manager can boost');
    const now = Date.now();
    if (now < room.game.managerCooldown) return socket.emit('error', 'Boost on cooldown');

    room.game.boostActive = true;
    room.game.boostEnd = now + 15000; // 15 second boost
    room.game.managerCooldown = now + 60000; // 60 second cooldown
    room.game.satisfaction = Math.min(100, room.game.satisfaction + 5);
    addLog(room, `⚡ Manager activated a Team Boost! All actions are faster for 15s!`);
    broadcastRoom(room);
  });

  socket.on('doSabotage', ({ code, type }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'game') return;
    const player = room.players[socket.id];
    if (!player || player.ejected || player.role !== 'Saboteur') return;
    const g = room.game;
    const now = Date.now();
    if (now < player.busyUntil) return socket.emit('error', 'You are busy');

    const cooldowns = player.sabotageCooldowns;
    const COOLDOWN = 30000; // 30s per ability

    if (cooldowns[type] && cooldowns[type] > now) {
      return socket.emit('error', 'This ability is on cooldown');
    }

    const activeOrders = g.orders.filter(o => o.status === 'active');

    switch (type) {
      case 'slowOrder': {
        if (!activeOrders.length) return socket.emit('error', 'No orders to slow');
        const target = activeOrders[Math.floor(Math.random() * activeOrders.length)];
        target.slowed = true;
        target.slowedUntil = now + 20000;
        addLog(room, '⏱️ A dish was delayed...');
        break;
      }
      case 'burnDish': {
        const cookableOrders = activeOrders.filter(o =>
          o.steps[o.currentStepIndex]?.toLowerCase().includes('cook') ||
          o.steps[o.currentStepIndex]?.toLowerCase().includes('bake')
        );
        const target = cookableOrders.length ? cookableOrders[Math.floor(Math.random() * cookableOrders.length)] : activeOrders[Math.floor(Math.random() * activeOrders.length)];
        if (!target) return socket.emit('error', 'No orders to burn');
        target.patience = Math.max(1, target.patience * 0.3);
        g.satisfaction = Math.max(0, g.satisfaction - 3);
        addLog(room, '🔥 Something burned in the kitchen...');
        break;
      }
      case 'createMess': {
        g.satisfaction = Math.max(0, g.satisfaction - 5);
        addLog(room, '🗑️ A mess appeared near the prep area.');
        break;
      }
      case 'reduceSatisfaction': {
        g.satisfaction = Math.max(0, g.satisfaction - 7);
        addLog(room, '😠 A customer became frustrated.');
        break;
      }
      case 'hideIngredient': {
        if (!activeOrders.length) return socket.emit('error', 'No orders');
        const target = activeOrders[Math.floor(Math.random() * activeOrders.length)];
        target.hidden = true;
        target.hiddenUntil = now + 15000;
        addLog(room, '🔍 An ingredient went missing...');
        break;
      }
      case 'causeKitchenMistake': {
        if (!activeOrders.length) return socket.emit('error', 'No orders');
        const target = activeOrders[Math.floor(Math.random() * activeOrders.length)];
        if (target.currentStepIndex > 0) target.currentStepIndex--;
        target.lockedBy = null;
        g.satisfaction = Math.max(0, g.satisfaction - 4);
        addLog(room, '⚠️ Something went wrong in the kitchen.');
        break;
      }
      default:
        return socket.emit('error', 'Unknown sabotage');
    }

    cooldowns[type] = now + COOLDOWN;
    player.busyUntil = now + 1500;
    broadcastRoom(room);
  });

  socket.on('callVote', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'game') return;
    const player = room.players[socket.id];
    if (!player || player.ejected) return;
    const g = room.game;
    if (g.votesUsed >= MAX_VOTES) return socket.emit('error', 'No votes remaining');
    if (g.activeVote) return socket.emit('error', 'Vote already in progress');

    g.votesUsed++;
    g.activeVote = {
      caller: player.name,
      votes: {},          // playerId -> targetId
      deadline: Date.now() + 30000, // 30 seconds
      result: null
    };
    addLog(room, `🗳️ ${player.name} called a vote! (${MAX_VOTES - g.votesUsed} remaining)`);
    broadcastRoom(room);

    // Auto-resolve after 30s
    setTimeout(() => {
      if (room.phase !== 'game' || !g.activeVote) return;
      resolveVote(room);
    }, 31000);
  });

  socket.on('castVote', ({ code, targetId }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'game') return;
    const player = room.players[socket.id];
    if (!player || player.ejected) return;
    const g = room.game;
    if (!g.activeVote) return;
    if (g.activeVote.votes[socket.id]) return socket.emit('error', 'Already voted');
    if (!room.players[targetId]) return socket.emit('error', 'Invalid target');

    g.activeVote.votes[socket.id] = targetId;

    // Check if all active players voted
    const activePlayers = Object.values(room.players).filter(p => !p.ejected);
    if (Object.keys(g.activeVote.votes).length >= activePlayers.length) {
      resolveVote(room);
    } else {
      broadcastRoom(room);
    }
  });

  function resolveVote(room) {
    const g = room.game;
    if (!g.activeVote) return;

    // Tally votes
    const tally = {};
    Object.values(g.activeVote.votes).forEach(targetId => {
      tally[targetId] = (tally[targetId] || 0) + 1;
    });

    let maxVotes = 0;
    let ejectedId = null;
    Object.entries(tally).forEach(([id, count]) => {
      if (count > maxVotes) { maxVotes = count; ejectedId = id; }
    });

    if (ejectedId && room.players[ejectedId]) {
      const ejected = room.players[ejectedId];
      ejected.ejected = true;
      const wasSaboteur = ejected.role === 'Saboteur';
      if (wasSaboteur) {
        g.satisfaction = Math.min(100, g.satisfaction + 20);
        g.revenue += 100;
        addLog(room, `🎉 ${ejected.name} was ejected! They WERE the saboteur! Team gets a boost!`);
      } else {
        addLog(room, `😔 ${ejected.name} was ejected... They were innocent (${ejected.role}).`);
      }
      io.to(room.code).emit('playerEjected', {
        name: ejected.name,
        wasSaboteur,
        role: ejected.role
      });
    } else {
      addLog(room, '🤷 Vote ended with no majority. No one ejected.');
    }

    g.activeVote = null;
    broadcastRoom(room);
    checkEndConditions(room);
  }

  socket.on('requestState', ({ code }) => {
    const room = getRoom(code);
    if (!room) return socket.emit('error', 'Room not found');
    socket.emit('gameState', getPrivateState(room, socket.id));
  });

  socket.on('disconnect', () => {
    // Find the room this player was in
    for (const [code, room] of Object.entries(rooms)) {
      if (room.players[socket.id]) {
        const name = room.players[socket.id].name;
        if (room.phase === 'lobby') {
          delete room.players[socket.id];
          if (room.host === socket.id) {
            const remaining = Object.keys(room.players);
            if (remaining.length === 0) { delete rooms[code]; return; }
            room.host = remaining[0];
          }
          broadcastRoom(room);
        } else {
          // Mark as ejected instead of removing (keeps game integrity)
          room.players[socket.id].ejected = true;
          if (room.phase === 'game') addLog(room, `⚠️ ${name} disconnected.`);
          broadcastRoom(room);
        }
        break;
      }
    }
  });

  socket.on('returnToLobby', ({ code }) => {
    const room = getRoom(code);
    if (!room) return;
    // Reset room to lobby
    room.phase = 'lobby';
    if (room.game?.tickInterval) clearInterval(room.game.tickInterval);
    Object.values(room.players).forEach(p => {
      p.role = null; p.fakeRole = null; p.ready = false;
      p.ejected = false; p.busyUntil = 0; p.sabotageCooldowns = {};
    });
    room.game = null;
    broadcastRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Kitchen Suspect running on http://localhost:${PORT}`));
