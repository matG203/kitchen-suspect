/* ═══════════════════════════════════════════
   Kitchen Suspect — Client Game Logic
   ═══════════════════════════════════════════ */

const socket = io();

// ─── State ────────────────────────────────────────────────────────────────────
let myId = socket.id;
let myRole = null;
let myFakeRole = null;
let currentCode = null;
let currentState = null;
let busyTimer = null;
let busyBarInterval = null;
let busyUntil = 0;
let voteCountdownInterval = null;
let sabCooldownInterval = null;
let myVote = null;
let hasVoted = false;

// ─── Role Helpers ─────────────────────────────────────────────────────────────
const ROLE_EMOJIS = {
  'Head Chef': '👨‍🍳', 'Sous Chef': '🧑‍🍳', 'Server': '🤵',
  'Cleaner': '🧹', 'Manager': '📋', 'Saboteur': '🎭'
};
const DISH_EMOJIS = { Burger: '🍔', Pizza: '🍕', Salad: '🥗' };
const SABOTAGE_ACTIONS = [
  { type: 'slowOrder',           label: '⏱️ Slow Order',       desc: 'Delay an order' },
  { type: 'burnDish',            label: '🔥 Burn Dish',         desc: 'Ruin a cooking dish' },
  { type: 'createMess',          label: '🗑️ Create Mess',       desc: '-5 satisfaction' },
  { type: 'reduceSatisfaction',  label: '😠 Frustrate Customer', desc: '-7 satisfaction' },
  { type: 'hideIngredient',      label: '🔍 Hide Ingredient',   desc: 'Block an order 15s' },
  { type: 'causeKitchenMistake', label: '⚠️ Kitchen Mistake',   desc: 'Reset an order step' },
];

// ─── Screen Management ────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + id);
  if (el) el.classList.add('active');
}

function showError(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function hideError(elId) {
  const el = document.getElementById(elId);
  if (el) el.classList.add('hidden');
}

// ─── Home Screen ──────────────────────────────────────────────────────────────
function createRoom() {
  const name = document.getElementById('home-name').value.trim();
  if (!name) return showError('home-error', 'Please enter your name first!');
  socket.emit('createRoom', { name });
}

function joinRoom() {
  const name = document.getElementById('home-name').value.trim();
  const code = document.getElementById('home-code').value.trim().toUpperCase();
  if (!name) return showError('home-error', 'Please enter your name first!');
  if (!code || code.length !== 4) return showError('home-error', 'Enter a 4-letter room code!');
  socket.emit('joinRoom', { code, name });
}

document.getElementById('home-code').addEventListener('input', function() {
  this.value = this.value.toUpperCase();
});
document.getElementById('home-name').addEventListener('keypress', e => { if (e.key === 'Enter') createRoom(); });
document.getElementById('home-code').addEventListener('keypress', e => { if (e.key === 'Enter') joinRoom(); });

// ─── Lobby Screen ─────────────────────────────────────────────────────────────
function copyCode() {
  if (currentCode) {
    navigator.clipboard.writeText(currentCode).catch(() => {});
    const btn = document.querySelector('.btn-copy');
    btn.textContent = '✅';
    setTimeout(() => btn.textContent = '📋', 1500);
  }
}

function startGame() {
  socket.emit('startGame', { code: currentCode });
}

// ─── Role Reveal ──────────────────────────────────────────────────────────────
function confirmReady() {
  socket.emit('readyToPlay', { code: currentCode });
  document.querySelector('#screen-rolereveal .btn').disabled = true;
  document.querySelector('#screen-rolereveal .btn').textContent = '⏳ Waiting for others…';
}

// ─── Game Actions ─────────────────────────────────────────────────────────────
function doClean() {
  if (isBusy()) return showError('action-error', 'Finish your current task first!');
  socket.emit('doClean', { code: currentCode });
}

function doManagerBoost() {
  socket.emit('doManagerBoost', { code: currentCode });
}

function callVote() {
  if (!currentState?.game) return;
  if (currentState.game.votesUsed >= 2) return showError('action-error', 'No votes remaining!');
  if (currentState.game.activeVote) return showError('action-error', 'Vote already in progress!');
  socket.emit('callVote', { code: currentCode });
}

function doTask(orderId, action) {
  if (isBusy()) return showError('action-error', 'You are busy! Wait for your task to finish.');
  socket.emit('doTask', { code: currentCode, orderId, action });
}

function doSabotage(type) {
  socket.emit('doSabotage', { code: currentCode, type });
}

function isBusy() {
  return Date.now() < busyUntil;
}

function returnToLobby() {
  socket.emit('returnToLobby', { code: currentCode });
}

function closeEjectNotice() {
  document.getElementById('eject-notice').classList.add('hidden');
}

// ─── Vote UI ──────────────────────────────────────────────────────────────────
function renderVoteModal(state) {
  const vote = state.game?.activeVote;
  const modal = document.getElementById('vote-modal');

  if (!vote) {
    modal.classList.add('hidden');
    if (voteCountdownInterval) { clearInterval(voteCountdownInterval); voteCountdownInterval = null; }
    return;
  }

  modal.classList.remove('hidden');
  document.getElementById('vote-caller-text').textContent = `${vote.caller} called a vote!`;

  const options = document.getElementById('vote-options');
  options.innerHTML = '';
  state.players.forEach(p => {
    if (p.ejected) return;
    const btn = document.createElement('button');
    btn.className = 'vote-btn' + (p.id === myId ? ' me' : '');
    btn.textContent = p.name + (p.id === myId ? ' (you)' : '');

    const isMe = p.id === myId;
    if (hasVoted || isMe) {
      btn.disabled = true;
    } else {
      btn.onclick = () => castVote(p.id);
    }
    if (myVote === p.id) btn.classList.add('voted');

    options.appendChild(btn);
  });

  const voteCount = vote.votes ? Object.keys(vote.votes).length : 0;
  const activeCount = state.players.filter(p => !p.ejected).length;
  document.getElementById('vote-status-text').textContent = `${voteCount}/${activeCount} votes cast`;

  // Countdown
  if (!voteCountdownInterval) {
    const deadline = Date.now() + 30000;
    const display = document.getElementById('vote-timer-display');
    voteCountdownInterval = setInterval(() => {
      const rem = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      display.textContent = `⏱️ ${rem}s remaining`;
      if (rem === 0) { clearInterval(voteCountdownInterval); voteCountdownInterval = null; }
    }, 500);
  }
}

function castVote(targetId) {
  if (hasVoted) return;
  hasVoted = true;
  myVote = targetId;
  socket.emit('castVote', { code: currentCode, targetId });
}

// ─── Busy Bar ─────────────────────────────────────────────────────────────────
function startBusyBar(duration) {
  clearInterval(busyBarInterval);
  busyUntil = Date.now() + duration;
  const wrap = document.getElementById('busy-bar-wrap');
  const bar = document.getElementById('busy-bar');
  const label = document.getElementById('my-busy-label');
  wrap.classList.remove('hidden');
  label.classList.remove('hidden');

  const start = Date.now();
  bar.style.width = '100%';

  busyBarInterval = setInterval(() => {
    const elapsed = Date.now() - start;
    const pct = Math.max(0, 100 - (elapsed / duration) * 100);
    bar.style.width = pct + '%';
    if (pct <= 0) {
      clearInterval(busyBarInterval);
      wrap.classList.add('hidden');
      label.classList.add('hidden');
      busyUntil = 0;
    }
  }, 50);
}

// ─── Main Render ──────────────────────────────────────────────────────────────
function renderState(state) {
  currentState = state;
  myId = socket.id;

  if (state.phase === 'lobby') {
    renderLobby(state);
  } else if (state.phase === 'game') {
    renderGame(state);
  }
}

function renderLobby(state) {
  showScreen('lobby');
  currentCode = state.code;
  document.getElementById('lobby-code').textContent = state.code;
  document.getElementById('lobby-count').textContent = state.players.length;

  const grid = document.getElementById('lobby-players');
  grid.innerHTML = '';
  state.players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'player-chip' + (p.id === state.host ? ' host' : '');
    chip.textContent = p.name;
    grid.appendChild(chip);
  });

  const startBtn = document.getElementById('lobby-start-btn');
  if (state.host === myId && state.players.length >= 6) {
    startBtn.classList.remove('hidden');
  } else if (state.host === myId) {
    startBtn.classList.add('hidden');
  } else {
    startBtn.classList.add('hidden');
  }
}

function renderGame(state) {
  showScreen('game');
  const g = state.game;
  if (!g) return;

  // HUD
  const mins = Math.floor(g.timer / 60);
  const secs = g.timer % 60;
  const timerEl = document.getElementById('hud-timer');
  timerEl.textContent = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
  timerEl.className = 'hud-value timer-value' + (g.timer < 120 ? ' danger' : g.timer < 300 ? ' warning' : '');

  const revEl = document.getElementById('hud-revenue');
  revEl.textContent = '$' + g.revenue;
  revEl.className = 'hud-value' + (g.revenue >= g.revenueTarget ? ' ' : '');

  document.getElementById('hud-target').textContent = '$' + g.revenueTarget;

  const satEl = document.getElementById('hud-satisfaction');
  satEl.textContent = g.satisfaction;
  satEl.className = 'hud-value' + (g.satisfaction < 30 ? ' danger' : g.satisfaction < 60 ? ' warning' : '');

  const failEl = document.getElementById('hud-failed');
  failEl.textContent = g.failedOrders + '/8';
  failEl.className = 'hud-value' + (g.failedOrders >= 6 ? ' danger' : g.failedOrders >= 4 ? ' warning' : '');

  // My status
  const displayRole = myRole === 'Saboteur' ? myFakeRole : myRole;
  const emoji = ROLE_EMOJIS[displayRole] || '👤';
  document.getElementById('my-role-badge').textContent = `${emoji} ${displayRole}`;

  // Boost banner
  const existing = document.getElementById('boost-banner');
  if (existing) existing.remove();
  if (g.boostActive) {
    const banner = document.createElement('div');
    banner.id = 'boost-banner';
    banner.className = 'boost-banner';
    banner.textContent = '⚡ Team Boost Active! Faster actions!';
    document.getElementById('my-status').after(banner);
  }

  // Manager/vote buttons
  if (myRole === 'Manager') {
    const btn = document.getElementById('btn-boost');
    btn.classList.remove('hidden');
    btn.disabled = g.managerOnCooldown;
    btn.textContent = g.managerOnCooldown ? '⚡ Boost (CD)' : '⚡ Team Boost';
  }

  const voteBtn = document.getElementById('btn-vote');
  const votesLeft = 2 - g.votesUsed;
  voteBtn.textContent = `🗳️ Vote (${votesLeft} left)`;
  voteBtn.disabled = votesLeft <= 0 || !!g.activeVote;

  // Ejected check
  if (state.myEjected) {
    document.getElementById('btn-vote').disabled = true;
    document.getElementById('btn-boost').disabled = true;
    document.querySelector('.actions-panel').style.opacity = '0.4';
    document.querySelector('.actions-panel').style.pointerEvents = 'none';
  }

  // Orders
  renderOrders(state, g);

  // Sabotage panel
  if (myRole === 'Saboteur' && !state.myEjected) {
    renderSabotagePanel(state);
  } else {
    document.getElementById('sabotage-panel').classList.add('hidden');
  }

  // Players
  renderGamePlayers(state);

  // Event Log
  const log = document.getElementById('event-log');
  log.innerHTML = '';
  (g.log || []).forEach((entry, i) => {
    const div = document.createElement('div');
    div.className = 'log-entry' + (i < 3 ? ' recent' : '');
    div.textContent = entry.msg;
    log.appendChild(div);
  });

  // Vote modal
  if (!g.activeVote) { hasVoted = false; myVote = null; }
  renderVoteModal(state);
}

function renderOrders(state, g) {
  const list = document.getElementById('orders-list');
  const activeOrders = g.orders.filter(o => o.status !== 'done');

  if (activeOrders.length === 0) {
    list.innerHTML = '<p style="color:var(--text-dim);font-size:0.9rem;padding:12px;">No active orders — help is on the way! 🍽️</p>';
    return;
  }

  list.innerHTML = '';
  activeOrders.forEach(order => {
    const pct = (order.patience / order.maxPatience) * 100;
    const isUrgent = pct < 25;
    const isWarning = pct < 50;
    const isHidden = order.hidden;
    const isLocked = order.lockedBy && order.lockedBy !== myId;
    const isFailed = order.status === 'failed';

    const card = document.createElement('div');
    card.className = 'order-card' + (isUrgent ? ' order-urgent' : '') + (isHidden ? ' order-hidden' : '');

    const barClass = isUrgent ? 'danger' : isWarning ? 'warn' : '';
    const dishEmoji = DISH_EMOJIS[order.dish] || '🍽️';

    // Step dots
    let dotsHTML = '';
    for (let i = 0; i < order.totalSteps; i++) {
      let cls = 'step-dot';
      if (i < order.currentStepIndex) cls += ' done';
      else if (i === order.currentStepIndex) cls += ' current';
      dotsHTML += `<div class="${cls}"></div>`;
    }

    let actionHTML = '';
    if (isFailed) {
      actionHTML = `<button class="order-action-btn" disabled>❌ Failed</button>`;
    } else if (isHidden) {
      actionHTML = `<div class="order-hidden-msg">🔍 Ingredient missing… wait!</div>`;
    } else if (isLocked) {
      const locker = state.players.find(p => p.id === order.lockedBy);
      actionHTML = `<div class="order-locked-msg">👤 ${locker ? locker.name : 'Someone'} is working on this…</div>`;
    } else if (!isBusy() && !state.myEjected) {
      actionHTML = `<button class="order-action-btn" onclick="doTask('${order.id}', '${order.currentStep}')">
        ▶ ${order.currentStep}
      </button>`;
    } else if (state.myEjected) {
      actionHTML = `<div class="order-locked-msg">You are ejected</div>`;
    } else {
      actionHTML = `<button class="order-action-btn" disabled>⏳ Finish current task first</button>`;
    }

    card.innerHTML = `
      <div class="order-header">
        <span class="order-dish">${dishEmoji} ${order.dish}</span>
        <span class="order-reward">+$${order.reward}</span>
      </div>
      <div class="order-step">Next: <strong>${isHidden ? '???' : order.currentStep}</strong></div>
      <div class="order-steps-track">${dotsHTML}</div>
      <div class="patience-bar-wrap">
        <div class="patience-bar ${barClass}" style="width:${pct}%"></div>
      </div>
      ${actionHTML}
    `;

    list.appendChild(card);
  });
}

function renderSabotagePanel(state) {
  const panel = document.getElementById('sabotage-panel');
  panel.classList.remove('hidden');

  const grid = document.getElementById('sabotage-btns');
  grid.innerHTML = '';

  const now = Date.now();
  const cooldowns = state.mySabotageCooldowns || {};

  SABOTAGE_ACTIONS.forEach(sab => {
    const cdEnd = cooldowns[sab.type] || 0;
    const onCd = cdEnd > now;
    const cdRemain = onCd ? Math.ceil((cdEnd - now) / 1000) : 0;

    const btn = document.createElement('button');
    btn.className = 'btn-sab';
    btn.disabled = onCd || isBusy();
    btn.innerHTML = `${sab.label}<span class="sab-cd">${onCd ? `⏳ ${cdRemain}s` : sab.desc}</span>`;
    btn.onclick = () => doSabotage(sab.type);
    grid.appendChild(btn);
  });
}

function renderGamePlayers(state) {
  const list = document.getElementById('game-players');
  list.innerHTML = '';
  state.players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'game-player-chip' + (p.ejected ? ' ejected' : '');
    const dotClass = p.ejected ? 'ejected' : p.busy ? 'busy' : '';
    chip.innerHTML = `
      <div class="player-dot ${dotClass}"></div>
      <span>${p.name}${p.id === myId ? ' (you)' : ''}</span>
      <span class="player-role-tag">${p.fakeRole}</span>
    `;
    list.appendChild(chip);
  });
}

// ─── Socket Events ────────────────────────────────────────────────────────────
socket.on('connect', () => {
  myId = socket.id;
});

socket.on('roomCreated', ({ code }) => {
  currentCode = code;
});

socket.on('roleReveal', ({ role, fakeRole, bonus }) => {
  myRole = role;
  myFakeRole = fakeRole;

  const isSab = role === 'Saboteur';
  const displayRole = isSab ? fakeRole : role;
  const emoji = ROLE_EMOJIS[role] || '👤';

  document.getElementById('role-emoji').textContent = emoji;
  document.getElementById('role-title').textContent = isSab ? `Saboteur` : role;
  document.getElementById('role-public-label').textContent = isSab
    ? `Others see you as: ${fakeRole}`
    : `Your public role: ${fakeRole}`;
  document.getElementById('role-bonus').textContent = '✨ ' + bonus;

  if (isSab) {
    document.getElementById('role-saboteur-hint').classList.remove('hidden');
  } else {
    document.getElementById('role-saboteur-hint').classList.add('hidden');
  }

  showScreen('rolereveal');
});

socket.on('gameState', (state) => {
  // Reset ready button if back in lobby
  if (state.phase === 'lobby') {
    const btn = document.querySelector('#screen-rolereveal .btn');
    if (btn) { btn.disabled = false; btn.textContent = "I'm Ready! 👊"; }
    myRole = null; myFakeRole = null; hasVoted = false; myVote = null;
    busyUntil = 0;
    clearInterval(busyBarInterval);
    document.getElementById('busy-bar-wrap').classList.add('hidden');
    document.getElementById('my-busy-label').classList.add('hidden');
  }
  renderState(state);
});

socket.on('taskStarted', ({ orderId, action, duration }) => {
  startBusyBar(duration);
});

socket.on('playerJoined', ({ name }) => {
  // Already handled by gameState
});

socket.on('playerEjected', ({ name, wasSaboteur, role }) => {
  const notice = document.getElementById('eject-notice');
  notice.classList.remove('hidden');
  document.getElementById('eject-emoji').textContent = wasSaboteur ? '🎉' : '😔';
  document.getElementById('eject-title').textContent = wasSaboteur
    ? `${name} was the Saboteur!`
    : `${name} was innocent!`;
  document.getElementById('eject-body').textContent = wasSaboteur
    ? `Great detective work! They were the Saboteur. The team gets a boost!`
    : `${name} was the ${role}. The real saboteur is still out there…`;
});

socket.on('gameEnded', (data) => {
  showScreen('end');
  document.getElementById('end-result-emoji').textContent = data.teamWin ? '🏆' : '💀';
  document.getElementById('end-result-title').textContent = data.teamWin ? 'Team Wins!' : 'Saboteur Wins!';
  document.getElementById('end-result-reason').textContent = data.reason;
  document.getElementById('end-saboteur').textContent = data.saboteurName;
  document.getElementById('end-revenue').textContent = '$' + data.revenue;
  document.getElementById('end-target').textContent = '$' + data.revenueTarget;
  document.getElementById('end-failed').textContent = data.failedOrders;

  const endPlayers = document.getElementById('end-players');
  endPlayers.innerHTML = '';
  data.players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'end-player-row'
      + (p.role === 'Saboteur' ? ' was-saboteur' : '')
      + (p.ejected ? ' ejected-tag' : '');
    row.innerHTML = `
      <span>${p.role === 'Saboteur' ? '🎭' : ROLE_EMOJIS[p.role] || '👤'} ${p.name}</span>
      <span class="role-tag">${p.role}${p.ejected ? ' 🚫' : ''}</span>
    `;
    endPlayers.appendChild(row);
  });
});

socket.on('error', (msg) => {
  // Show in the currently visible screen
  const game = document.getElementById('screen-game');
  if (game.classList.contains('active')) {
    showError('action-error', msg);
  } else {
    showError('home-error', msg);
    showError('lobby-error', msg);
  }
});

// Periodic sabotage cooldown refresh
setInterval(() => {
  if (myRole === 'Saboteur' && currentState?.game && currentState.phase === 'game') {
    renderSabotagePanel(currentState);
  }
}, 1000);

// Re-request state on reconnect
socket.on('reconnect', () => {
  if (currentCode) socket.emit('requestState', { code: currentCode });
});

// Handle page visibility (reconnect logic)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentCode) {
    socket.emit('requestState', { code: currentCode });
  }
});
