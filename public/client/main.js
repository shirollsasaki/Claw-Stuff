// Constants (should match server)
const ARENA_WIDTH = 2000;
const ARENA_HEIGHT = 2000;

// Sizes (world units). Must match `src/shared/constants.ts` for drawing/hitbox parity. Snakes +50% size.
const HEAD_RADIUS = 15;
const SEGMENT_RADIUS = 13.5;
const FOOD_RADIUS = 3.375; // 25% smaller (match server)

// Extra client-only scale for snake/food drawing
const VISUAL_SIZE_FACTOR = 3.6;

// Debug: draw physics collider circles. Enable with ?debugColliders=1 in URL.
const DEBUG_COLLIDERS = /[?&]debugColliders=1/i.test(location.search);

// Skins: Body/Eyes/Mouth layered assets under public/skins/Body, Eyes, Mouth.
// Each snake has bodyId, eyesId, mouthId (paths like "Common/aqua.png").
// Head = body + eyes + mouth stacked; trailing segments = body only. Scale 100% at head to 60% at tail.
const skinImageCache = {}; // key "Body/path" | "Eyes/path" | "Mouth/path" -> { img: Image, loaded: boolean }

function skinPartUrl(category, pathId) {
  if (!pathId) return null;
  const encoded = pathId.split('/').map(encodeURIComponent).join('/');
  return `/skins/${category}/${encoded}`;
}

function getOrLoadSkinImage(category, pathId) {
  const key = `${category}/${pathId}`;
  if (skinImageCache[key]) return skinImageCache[key];
  const url = skinPartUrl(category, pathId);
  if (!url) return null;
  const entry = { img: new Image(), loaded: false };
  skinImageCache[key] = entry;
  entry.img.onload = () => { entry.loaded = true; };
  entry.img.onerror = () => {};
  entry.img.src = url;
  return entry;
}

function getSkinImages(snake) {
  const bodyId = snake.bodyId;
  const eyesId = snake.eyesId;
  const mouthId = snake.mouthId;
  if (!bodyId || !eyesId || !mouthId) return null;
  const body = getOrLoadSkinImage('Body', bodyId);
  const eyes = getOrLoadSkinImage('Eyes', eyesId);
  const mouth = getOrLoadSkinImage('Mouth', mouthId);
  if (body?.loaded && eyes?.loaded && mouth?.loaded) {
    return { body: body.img, eyes: eyes.img, mouth: mouth.img };
  }
  return null;
}

// Trigger loads for all snakes in current game state (so images ready soon)
function ensureSkinLoadsForState(state) {
  if (!state?.snakes) return;
  for (const snake of state.snakes) {
    if (snake.bodyId && snake.eyesId && snake.mouthId) {
      getOrLoadSkinImage('Body', snake.bodyId);
      getOrLoadSkinImage('Eyes', snake.eyesId);
      getOrLoadSkinImage('Mouth', snake.mouthId);
    }
  }
}

// Canvas setup
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

// UI elements
const matchPhaseEl = document.getElementById('match-phase');
const timerEl = document.getElementById('timer');
const playerCountEl = document.getElementById('player-count');
const leaderboardEl = document.getElementById('leaderboard-entries');
const botCountEl = document.getElementById('bot-count');
const totalGamesEl = document.getElementById('total-games');
const globalLeaderboardEl = document.getElementById('global-leaderboard-entries');
const connectionStatusEl = document.getElementById('connection-status');
const waitingScreen = document.getElementById('waiting-screen');
const countdownEl = document.getElementById('countdown');
const winnerScreen = document.getElementById('winner-screen');
const winnerNameEl = document.getElementById('winner-name');
const winnerScoreEl = document.getElementById('winner-score');
const winnerTableEl = document.getElementById('winner-table');

// Game state
let gameState = null;
let camera = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2, scale: 1, scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
let targetCamera = { ...camera };
// Resize canvas: fill parent exactly so arena maps 1:1 to container (perfect wrap on all edges)
function resizeCanvas() {
  const container = document.getElementById('game-container');
  let w = container.clientWidth;
  let h = container.clientHeight;
  // On mobile, clientWidth/Height can be 0 before layout; fallback to viewport
  if (!w || !h) {
    w = w || Math.min(document.documentElement.clientWidth, window.innerWidth || 0);
    h = h || Math.min(document.documentElement.clientHeight, window.innerHeight || 0);
  }
  if (!w || !h) return;
  canvas.width = w;
  canvas.height = h;
  // Non-uniform scale: arena fills container so no letterboxing on any device
  camera.scaleX = w / ARENA_WIDTH;
  camera.scaleY = h / ARENA_HEIGHT;
  camera.offsetX = 0;
  camera.offsetY = 0;
  // For drawing radii/fonts use min so circles stay round
  camera.scale = Math.min(camera.scaleX, camera.scaleY);
}

window.addEventListener('resize', resizeCanvas);
// ResizeObserver so we pick up correct size on mobile after layout (and when chrome shows/hides)
const gameContainer = document.getElementById('game-container');
if (gameContainer && typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => resizeCanvas()).observe(gameContainer);
}
resizeCanvas();
// Retry once after layout (helps mobile when container size isn't ready yet)
requestAnimationFrame(() => { requestAnimationFrame(resizeCanvas); });

// Fetch betting config and toggle tab visibility
async function initBettingConfig() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const status = await res.json();
    const bettingEnabled = status.bettingEnabled ?? false;
    
    // Toggle BETS and TOKEN tabs visibility
    const bettingTabs = document.querySelectorAll('[data-betting-tab="true"]');
    bettingTabs.forEach(tab => {
      if (bettingEnabled) {
        tab.style.display = '';
      } else {
        tab.style.display = 'none';
      }
    });
  } catch (err) {
    console.error('Failed to fetch betting config:', err);
    // Default to hiding betting tabs on error
    const bettingTabs = document.querySelectorAll('[data-betting-tab="true"]');
    bettingTabs.forEach(tab => {
      tab.style.display = 'none';
    });
  }
}

// Initialize betting config on page load
initBettingConfig();

// Connect to server
const socket = io();

socket.on('connect', () => {
  console.log('Connected to server');
  connectionStatusEl.textContent = 'Connected';
  connectionStatusEl.className = 'connected';
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
  connectionStatusEl.textContent = 'Disconnected - Reconnecting...';
  connectionStatusEl.className = 'disconnected';
});

socket.on('gameState', (state) => {
  gameState = state;
  ensureSkinLoadsForState(state);
  updateUI();
});

socket.on('status', (status) => {
  if (status.currentMatch) {
    if (status.currentMatch.phase === 'lobby') {
      showWaitingScreen(status.currentMatch);
      // Update player count while in lobby
      const count = status.currentMatch.playerCount ?? 0;
      const names = status.currentMatch.lobbyPlayers ?? [];
      playerCountEl.textContent = `${count} joined`;
      updateLobbyLeaderboard(count, names);
    } else {
      hideWaitingScreen();
    }
  } else if (status.nextMatch) {
    showNextMatchCountdown(status.nextMatch);
  }
});

socket.on('lobbyOpen', ({ matchId, startsAt }) => {
  showWaitingScreen({ startsAt, playerCount: 0 });
});

socket.on('matchEnd', (result) => {
  // Reflect winner +1s survival bonus in sidebar leaderboard (same as winner overlay)
  if (gameState && gameState.snakes && result.finalScores && Array.isArray(result.finalScores)) {
    const byName = new Map(result.finalScores.map((e) => [e.name, e]));
    for (const snake of gameState.snakes) {
      const entry = byName.get(snake.name);
      if (entry && entry.survivalMs != null) {
        snake.survivalMs = entry.survivalMs;
      }
    }
    updateUI(); // refresh sidebar so it shows adjusted times (winner +1s)
  }
  showWinner(result);
});

function showWaitingScreen(match) {
  waitingScreen.style.display = 'flex';
  winnerScreen.style.display = 'none';

  // No countdown until second bot joins (startsAt is 0)
  if (!match.startsAt || match.startsAt === 0) {
    countdownEl.textContent = 'Waiting for 2nd bot…';
    return;
  }

  const updateCountdown = () => {
    const now = Date.now();
    const remaining = Math.max(0, match.startsAt - now);
    const seconds = Math.ceil(remaining / 1000);
    countdownEl.textContent = `${seconds}s`;

    if (remaining > 0) {
      requestAnimationFrame(updateCountdown);
    }
  };
  updateCountdown();
}

function showNextMatchCountdown(nextMatch) {
  waitingScreen.style.display = 'flex';
  winnerScreen.style.display = 'none';
  
  const updateCountdown = () => {
    const now = Date.now();
    const remaining = Math.max(0, nextMatch.startsAt - now);
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.ceil((remaining % 60000) / 1000);
    countdownEl.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    
    if (remaining > 0) {
      requestAnimationFrame(updateCountdown);
    }
  };
  updateCountdown();
}

function hideWaitingScreen() {
  waitingScreen.style.display = 'none';
}

function formatSurvivalMs(ms) {
  if (ms == null || typeof ms !== 'number') return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function showWinner(result) {
  const winnerImgEl = document.getElementById('winner-snake-img');
  if (result.winner) {
    winnerNameEl.textContent = result.winner.name;
    winnerScoreEl.textContent = formatSurvivalMs(result.winner.survivalMs);
    if (winnerImgEl && result.winner.bodyId && result.winner.eyesId && result.winner.mouthId) {
      const q = new URLSearchParams({
        bodyId: result.winner.bodyId,
        eyesId: result.winner.eyesId,
        mouthId: result.winner.mouthId,
      });
      winnerImgEl.src = `/api/skins/preview?${q.toString()}`;
      winnerImgEl.alt = result.winner.name + ' snake';
      winnerImgEl.classList.remove('hidden');
    } else if (winnerImgEl) {
      winnerImgEl.classList.add('hidden');
      winnerImgEl.removeAttribute('src');
    }
  } else {
    winnerNameEl.textContent = 'No winner';
    winnerScoreEl.textContent = '0:00';
    if (winnerImgEl) {
      winnerImgEl.classList.add('hidden');
      winnerImgEl.removeAttribute('src');
    }
  }

  // Build per-match scoreboard (rank by survival; show survival time)
  if (result.finalScores && Array.isArray(result.finalScores)) {
    const rows = result.finalScores
      .slice()
      .sort((a, b) => (b.survivalMs ?? 0) - (a.survivalMs ?? 0))
      .map((entry, index) => {
        const isWinner = result.winner && entry.name === result.winner.name;
        const rank = index + 1;
        const survival = formatSurvivalMs(entry.survivalMs);
        return `
          <tr class="${isWinner ? 'highlight' : ''}">
            <td>${rank}</td>
            <td>${entry.name}</td>
            <td>${survival}</td>
          </tr>
        `;
      }).join('');

    winnerTableEl.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Agent</th>
            <th>Survival</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="3">No players</td></tr>'}
        </tbody>
      </table>
    `;
  } else {
    winnerTableEl.innerHTML = '';
  }

  winnerScreen.style.display = 'flex';
}

function updateLobbyLeaderboard(count, names) {
  // Only show lobby leaderboard when we don't have an active game state yet
  if (gameState && gameState.phase === 'active') return;

  if (count === 0) {
    leaderboardEl.innerHTML = '<div class="text-center text-sm text-slate-400 py-4">Waiting for bots to join...</div>';
    return;
  }

  const nameList = Array.isArray(names) && names.length > 0
    ? names.map((name, i) => `
        <div class="flex items-center gap-3 text-xs bg-slate-800 p-2 border-2 border-white shadow-[2px_2px_0_black] mb-2">
          <span class="bg-slate-600 text-white w-5 h-5 flex items-center justify-center font-black text-[10px] border border-white">${i + 1}</span>
          <span class="text-white font-bold">${escapeHtml(name)}</span>
        </div>
      `).join('')
    : `<div class="text-center text-sm text-slate-400 py-4">${count} bot${count === 1 ? '' : 's'} joined</div>`;

  leaderboardEl.innerHTML = nameList;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function updateUI() {
  if (!gameState) return;

  // Update match phase
  const phaseText = {
    'lobby': 'Lobby',
    'active': 'In Progress',
    'finished': 'Finished'
  };
  matchPhaseEl.textContent = phaseText[gameState.phase] || gameState.phase;
  matchPhaseEl.className = `match-phase phase-${gameState.phase}`;

  // Update timer
  if (gameState.phase === 'active') {
    const minutes = Math.floor(gameState.timeRemaining / 60);
    const seconds = Math.floor(gameState.timeRemaining % 60);
    timerEl.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    hideWaitingScreen();
  } else {
    timerEl.textContent = '--:--';
  }

  // Update player count
  const aliveCount = gameState.snakes.filter(s => s.alive).length;
  const totalCount = gameState.snakes.length;
  playerCountEl.textContent = `${aliveCount}/${totalCount} alive`;

  // Update leaderboard (rank by survival time)
  const sorted = [...gameState.snakes].sort((a, b) => (b.survivalMs ?? 0) - (a.survivalMs ?? 0));
  leaderboardEl.innerHTML = sorted.map((snake, index) => {
    const opacity = snake.alive ? '' : 'opacity-40 grayscale';
    const rankBg = index === 0 ? 'bg-[#facc15] text-black' : 'bg-slate-700 text-white';
    const survival = formatSurvivalMs(snake.survivalMs);
    return `
      <div class="flex items-center justify-between text-xs bg-slate-800 p-2 border-2 border-white shadow-[2px_2px_0_black] mb-2 transition-all ${opacity}">
        <div class="flex items-center gap-3">
          <span class="${rankBg} w-6 h-6 flex items-center justify-center font-black text-[10px] border border-white">${index + 1}</span>
          <div class="w-3 h-3 rounded-full border border-white" style="background: ${snake.color}"></div>
          <span class="text-white font-bold uppercase text-xs">${escapeHtml(snake.name)}</span>
        </div>
        <span class="font-black text-black bg-[#a3e635] px-2 py-0.5 border border-white text-[10px]">${survival}</span>
      </div>
    `;
  }).join('');
}

// Rendering
function render() {
  // Clear canvas
  ctx.fillStyle = '#0a0a1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!gameState) {
    // No game state yet
    ctx.fillStyle = '#333';
    ctx.font = '20px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for game...', canvas.width / 2, canvas.height / 2);
    requestAnimationFrame(render);
    return;
  }

  // Draw grid
  drawGrid();

  // Draw food
  for (const food of gameState.food) {
    drawFood(food[0], food[1], food[2]);
  }

  // Draw snakes
  for (const snake of gameState.snakes) {
    if (snake.alive || snake.segments.length > 0) {
      drawSnake(snake);
      if (DEBUG_COLLIDERS) drawSnakeColliders(snake);
    }
  }

  // Draw arena border
  drawBorder();

  requestAnimationFrame(render);
}

function worldToScreen(x, y) {
  return {
    x: x * camera.scaleX + camera.offsetX,
    y: y * camera.scaleY + camera.offsetY
  };
}

function drawGrid() {
  const gridSize = 100;
  ctx.strokeStyle = '#151525';
  ctx.lineWidth = 1;
  for (let x = 0; x <= ARENA_WIDTH; x += gridSize) {
    const a = worldToScreen(x, 0);
    const b = worldToScreen(x, ARENA_HEIGHT);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  for (let y = 0; y <= ARENA_HEIGHT; y += gridSize) {
    const a = worldToScreen(0, y);
    const b = worldToScreen(ARENA_WIDTH, y);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

function drawBorder() {
  ctx.strokeStyle = '#4ecdc4';
  ctx.lineWidth = 3;
  const topLeft = worldToScreen(0, 0);
  const bottomRight = worldToScreen(ARENA_WIDTH, ARENA_HEIGHT);
  ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
}

function drawFood(x, y, value) {
  const screen = worldToScreen(x, y);
  // Dropped food is slightly smaller than regular food.
  const base = value > 5 ? FOOD_RADIUS : FOOD_RADIUS * 0.75;
  const radius = base * camera.scale * VISUAL_SIZE_FACTOR;

  // Glow effect
  const gradient = ctx.createRadialGradient(
    screen.x, screen.y, 0,
    screen.x, screen.y, radius * 2
  );
  gradient.addColorStop(0, value > 5 ? 'rgba(255, 215, 0, 0.8)' : 'rgba(78, 205, 196, 0.8)');
  gradient.addColorStop(1, 'transparent');

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, radius * 2, 0, Math.PI * 2);
  ctx.fill();

  // Core
  ctx.fillStyle = value > 5 ? '#ffd700' : '#4ecdc4';
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

/** Draw physics collider circles (head + body) for debug. Use ?debugColliders=1. Matches visual size (same scale as drawn snake). */
function drawSnakeColliders(snake) {
  if (snake.segments.length === 0) return;
  const segments = snake.segments;
  const n = Math.max(segments.length - 1, 1);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const screen = worldToScreen(seg[0], seg[1]);
    const isHead = i === 0;
    // Same radius as drawSnake (visual scale + taper), scaled down slightly so outline sits inside drawn snake
    const sizeFactor = isHead ? 1 : (1 - (i / n) * 0.4);
    const baseRadius = isHead ? HEAD_RADIUS : SEGMENT_RADIUS;
    const screenRadius = baseRadius * sizeFactor * camera.scale * VISUAL_SIZE_FACTOR * 0.78;
    ctx.strokeStyle = isHead ? 'rgba(255, 80, 80, 0.9)' : 'rgba(255, 200, 80, 0.7)';
    ctx.lineWidth = Math.max(1, 2 * camera.scale);
    ctx.setLineDash(isHead ? [] : [4, 4]);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, screenRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawSnake(snake) {
  if (snake.segments.length === 0) return;

  const segments = snake.segments;
  const color = snake.color;
  const isAlive = snake.alive;

  const skin = getSkinImages(snake);

  // Helper to draw a skin layer (body, eyes, or mouth) with rotation.
  function drawSnakePart(img, x, y, angleRad, radius) {
    if (!img) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angleRad);
    const size = radius * 2;
    ctx.drawImage(img, -size / 2, -size / 2, size, size);
    ctx.restore();
  }

  // If we don't have a loaded skin, fall back to the original circle rendering.
  if (!skin) {
    // Draw body segments
    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = segments[i];
      const screen = worldToScreen(segment[0], segment[1]);
      const isHead = i === 0;
      
      // Size decreases toward tail (gentle taper so tail doesn't look too thin)
      const sizeFactor = isHead ? 1 : (1 - (i / segments.length) * 0.15);
      const baseRadius = isHead ? HEAD_RADIUS : SEGMENT_RADIUS;
      const radius = baseRadius * sizeFactor * camera.scale * VISUAL_SIZE_FACTOR;

      // Opacity for dead snakes
      ctx.globalAlpha = isAlive ? 1 : 0.3;

      // Draw segment
      ctx.fillStyle = isHead ? lightenColor(color, 20) : color;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 1;
    }

    // Draw eyes on head
    if (isAlive && segments.length > 0) {
      const head = segments[0];
      const screen = worldToScreen(head[0], head[1]);
      const angle = snake.angle * Math.PI / 180;
      const headRadius = HEAD_RADIUS * camera.scale * VISUAL_SIZE_FACTOR;
      const eyeOffset = headRadius * 0.5;
      const eyeRadius = headRadius * 0.25;

      // Left eye
      const leftEyeX = screen.x + Math.cos(angle - 0.5) * eyeOffset;
      const leftEyeY = screen.y + Math.sin(angle - 0.5) * eyeOffset;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(leftEyeX, leftEyeY, eyeRadius, 0, Math.PI * 2);
      ctx.fill();

      // Right eye
      const rightEyeX = screen.x + Math.cos(angle + 0.5) * eyeOffset;
      const rightEyeY = screen.y + Math.sin(angle + 0.5) * eyeOffset;
      ctx.beginPath();
      ctx.arc(rightEyeX, rightEyeY, eyeRadius, 0, Math.PI * 2);
      ctx.fill();

      // Pupils
      ctx.fillStyle = '#000';
      const pupilOffset = eyeRadius * 0.3;
      ctx.beginPath();
      ctx.arc(leftEyeX + Math.cos(angle) * pupilOffset, leftEyeY + Math.sin(angle) * pupilOffset, eyeRadius * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(rightEyeX + Math.cos(angle) * pupilOffset, rightEyeY + Math.sin(angle) * pupilOffset, eyeRadius * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw name above snake
    if (segments.length > 0) {
      const head = segments[0];
      const screen = worldToScreen(head[0], head[1]);
      ctx.fillStyle = isAlive ? '#fff' : '#666';
      ctx.font = `${12 * camera.scale * VISUAL_SIZE_FACTOR}px system-ui`;
      ctx.textAlign = 'center';
      ctx.fillText(snake.name, screen.x, screen.y - 20 * camera.scale * VISUAL_SIZE_FACTOR);
    }

    return;
  }

  // Layered rendering: body (base), then eyes, then mouth at head. Body only on trailing segments.
  // Scale linearly from 100% at head to 60% at tail (gentle taper so tail segments don't shrink too much).
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    const screen = worldToScreen(segment[0], segment[1]);
    const isHead = i === 0;
    const n = Math.max(segments.length - 1, 1);
    const sizeFactor = 1 - (i / n) * 0.4; // 1 at head, 0.6 at tail
    const baseRadius = isHead ? HEAD_RADIUS : SEGMENT_RADIUS;
    const radius = baseRadius * sizeFactor * camera.scale * VISUAL_SIZE_FACTOR;

    ctx.globalAlpha = isAlive ? 1 : 0.3;

    let angleRad = 0;
    if (isHead) {
      angleRad = (snake.angle * Math.PI) / 180;
    } else {
      const next = segments[i - 1];
      const dx = next[0] - segment[0];
      const dy = next[1] - segment[1];
      angleRad = Math.atan2(dy, dx);
    }

    drawSnakePart(skin.body, screen.x, screen.y, angleRad, radius);
    if (isHead) {
      drawSnakePart(skin.eyes, screen.x, screen.y, angleRad, radius);
      drawSnakePart(skin.mouth, screen.x, screen.y, angleRad, radius);
    }

    ctx.globalAlpha = 1;
  }

  // Draw name above snake
  if (segments.length > 0) {
    const head = segments[0];
    const screen = worldToScreen(head[0], head[1]);
    ctx.fillStyle = isAlive ? '#fff' : '#666';
    ctx.font = `${12 * camera.scale * VISUAL_SIZE_FACTOR}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText(snake.name, screen.x, screen.y - 20 * camera.scale * VISUAL_SIZE_FACTOR);
  }
}

function lightenColor(color, percent) {
  const num = parseInt(color.replace('#', ''), 16);
  const amt = Math.round(2.55 * percent);
  const R = (num >> 16) + amt;
  const G = (num >> 8 & 0x00FF) + amt;
  const B = (num & 0x0000FF) + amt;
  return '#' + (
    0x1000000 +
    (R < 255 ? R < 1 ? 0 : R : 255) * 0x10000 +
    (G < 255 ? G < 1 ? 0 : G : 255) * 0x100 +
    (B < 255 ? B < 1 ? 0 : B : 255)
  ).toString(16).slice(1);
}

// Start rendering (skins load on demand when snakes appear)
render();

// Global leaderboard polling
async function fetchGlobalLeaderboard() {
  try {
    const res = await fetch('/api/global-leaderboard');
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();

    const totalBots = data.totalBots ?? 0;
    const totalGames = data.totalGames ?? 0;
    const rows = Array.isArray(data.leaderboard) ? data.leaderboard : [];

    if (botCountEl) {
      botCountEl.textContent =
        totalBots === 1 ? '1 bot has played so far' : `${totalBots} bots have played so far`;
    }
    if (totalGamesEl) {
      totalGamesEl.textContent =
        totalGames === 1 ? '1 game played' : `${totalGames} games played`;
    }

    if (globalLeaderboardEl) {
      if (rows.length === 0) {
        globalLeaderboardEl.innerHTML = '<div class="text-center text-sm text-slate-400 py-4">No games played yet.</div>';
        return;
      }

      globalLeaderboardEl.innerHTML = rows
        .slice(0, 20)
        .map((row, index) => {
          const winRatePct = (row.winRate * 100).toFixed(1);
          const rankBg = index === 0 ? 'bg-[#facc15] text-black' : 'bg-slate-600 text-white';
          return `
            <div class="flex items-center justify-between text-xs bg-slate-800 p-2 border-2 border-white shadow-[2px_2px_0_black] mb-2">
              <div class="flex items-center gap-2">
                <span class="${rankBg} w-5 h-5 flex items-center justify-center font-black text-[10px] border border-white">${index + 1}</span>
                <span class="text-white font-bold">${escapeHtml(row.agentName)}</span>
              </div>
              <span class="font-bold bg-white text-black px-2 py-0.5 text-[10px]">${row.wins}/${row.matches} (${winRatePct}%)</span>
            </div>
          `;
        })
        .join('');
    }
  } catch (err) {
    console.error('Failed to fetch global leaderboard:', err);
  }
}

// Poll global leaderboard periodically
fetchGlobalLeaderboard();
setInterval(fetchGlobalLeaderboard, 15000);

// Participate sidebar: tab switching
document.querySelectorAll('.participate-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const tabName = tab.getAttribute('data-tab');
    document.querySelectorAll('.participate-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.participate-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    const panel = document.getElementById(`panel-${tabName}`);
    if (panel) panel.classList.add('active');
    document.querySelectorAll('.participate-tab').forEach((t) => {
      if (t !== tab) t.setAttribute('aria-selected', 'false');
    });
  });
});

// Copy buttons in Participate sidebar
document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-copy');
    const el = id ? document.getElementById(id) : null;
    const text = el && (el.value !== undefined ? el.value : el.textContent);
    if (text != null && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text.trim()).then(() => {
        const label = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = label; }, 1500);
      });
    } else {
      el && el.select();
      document.execCommand('copy');
    }
  });
});
