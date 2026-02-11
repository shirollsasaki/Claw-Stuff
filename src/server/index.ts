import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { MatchManager } from './game/match.js';
import { createRoutes } from './api/routes.js';
import { createBettingRoutes } from './betting/routes.js';
import { setEmitter } from './betting/service.js';
import { config } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3000;
const DEV_MODE = process.env.NODE_ENV !== 'production';
const clientUrl = process.env.CLIENT_URL;
const allowedOrigins = [
  'https://builder-arena.vercel.app',
  clientUrl,
  ...(DEV_MODE ? ['http://localhost:3000', 'http://127.0.0.1:3000'] : []),
].filter((origin): origin is string => Boolean(origin));

// Initialize Express
const app = express();
const httpServer = createServer(app);

// Initialize Socket.IO for spectators
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(cors());
app.use(express.json());

// Serve OpenClaw skill documentation so agents can discover rules/controls
app.get('/skill.md', (req, res) => {
  res.type('text/markdown');
  res.sendFile(join(__dirname, '../../SKILL.md'));
});

// Serve static files (spectator frontend)
app.use(express.static(join(__dirname, '../../public')));

// Initialize match manager
const matchManager = new MatchManager();

// API routes
app.use('/api', createRoutes(matchManager));
if (config.bettingEnabled) {
  app.use('/api/betting', createBettingRoutes());
} else {
  app.use('/api/betting', (_req, res) => {
    res.status(503).json({ error: 'Betting is temporarily disabled' });
  });
}

// Wire betting service WebSocket emitter so betting events are broadcast to spectators
if (config.bettingEnabled) {
  setEmitter((event: string, data: any) => {
    io.emit(event, data);
  });
}

// WebSocket connection for spectators
io.on('connection', (socket) => {
  console.log(`Spectator connected: ${socket.id}`);

  // Send current state immediately
  const state = matchManager.getSpectatorState();
  if (state) {
    socket.emit('gameState', state);
  }

  // Send server status
  socket.emit('status', matchManager.getStatus());

  // Handle human bet notification (frontend sends this after successful on-chain tx)
  if (config.bettingEnabled) {
    socket.on('humanBetPlaced', async (data: {
      matchId: string;
      bettorAddress: string;
      agentName: string;
      amountWei: string;
      txHash: string;
      token?: 'MON' | 'MCLAW';
    }) => {
      try {
        const { placeBet } = await import('./betting/service.js');
        await placeBet({
          bettorAddress: data.bettorAddress,
          bettorType: 'human',
          bettorName: null,
          matchId: data.matchId,
          agentName: data.agentName,
          amountWei: data.amountWei,
          token: data.token === 'MCLAW' ? 'MCLAW' : 'MON',
          txHash: data.txHash,
        });
      } catch (err) {
        console.error('[ws] humanBetPlaced handler failed:', err);
      }
    });
  }

  socket.on('disconnect', () => {
    console.log(`Spectator disconnected: ${socket.id}`);
  });
});

// Set up match manager callbacks
matchManager.onStateUpdate((state) => {
  io.emit('gameState', state);
});

matchManager.onMatchEndEvent((result) => {
  io.emit('matchEnd', result);
});

matchManager.onLobbyOpen((matchId, startsAt) => {
  io.emit('lobbyOpen', { matchId, startsAt });
  io.emit('status', matchManager.getStatus());
});

// Emit updated status whenever something about the lobby/match changes (e.g. players join)
matchManager.onStatusChange(() => {
  io.emit('status', matchManager.getStatus());
});

// Start server
httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                          🐍 CLAW IO 🐍                         ║
╠══════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}                      ║
║                                                              ║
║  Spectator view: http://localhost:${PORT}                        ║
║  API Status:     http://localhost:${PORT}/api/status             ║
║                                                              ║
║  Mode: ${DEV_MODE ? 'DEVELOPMENT (test keys allowed)' : 'PRODUCTION'}                       ║
╚══════════════════════════════════════════════════════════════╝
  `);

  // Start the match scheduler (async initialization)
  matchManager.start().catch((err) => {
    console.error('Failed to start match manager:', err);
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  matchManager.stop();
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
