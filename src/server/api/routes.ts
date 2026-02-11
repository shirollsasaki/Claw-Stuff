import { Router, Request, Response } from 'express';
import { MatchManager } from '../game/match.js';
import { getAgentSkins, getGlobalLeaderboard } from '../db.js';
import { verifyAgentApiKey, createTestAgent, checkRateLimit } from './auth.js';
import {
  JoinRequest,
  ActionRequest,
  GameStateResponse,
} from '../../shared/types.js';
import { resolveSkinToParts, toStoredSkinId, SKIN_PRESETS, DEFAULT_SKIN_ID } from '../../shared/skins.js';
import { getSkinOptions } from '../skinOptions.js';
import { generateSnake, getSkinPartPaths } from '../snakeGenerator.js';
import { ARENA_WIDTH, ARENA_HEIGHT, TICK_INTERVAL } from '../../shared/constants.js';
import { config } from '../config.js';

const DEV_MODE = process.env.NODE_ENV !== 'production';

export function createRoutes(matchManager: MatchManager): Router {
  const router = Router();

  // Middleware to extract API key
  const extractApiKey = (req: Request): string | null => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.slice(7);
  };

  // GET /api/status - No auth required
  router.get('/status', (req: Request, res: Response) => {
    const status = matchManager.getStatus();
    res.json({
      ...status,
      bettingEnabled: config.bettingEnabled,
    });
  });

  // POST /api/match/join - Requires API key auth
  router.post('/match/join', async (req: Request, res: Response) => {
    const apiKey = extractApiKey(req);
    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Missing or invalid Authorization header. Use: Bearer YOUR_BUILDER_ARENA_API_KEY',
      });
      return;
    }

    // Verify with Builder Arena API key format (or use test mode in dev)
    let agentInfo;
    if (DEV_MODE && apiKey.startsWith('test_')) {
      agentInfo = createTestAgent(apiKey.replace('test_', ''));
    } else {
      agentInfo = await verifyAgentApiKey(apiKey);
    }

    if (!agentInfo) {
      res.status(401).json({
        success: false,
        error: 'INVALID_API_KEY',
        message: 'Invalid Builder Arena API key. Use a key with ba_ prefix',
      });
      return;
    }

    const body = req.body as JoinRequest;

    // Resolve skin: custom bodyId/eyesId/mouthId combo, or preset skinId (must be owned).
    let storedSkinId: string;
    if (body.bodyId != null && body.eyesId != null && body.mouthId != null) {
      const options = getSkinOptions();
      const bodyOk = options.bodies.includes(body.bodyId);
      const eyesOk = options.eyes.includes(body.eyesId);
      const mouthOk = options.mouths.includes(body.mouthId);
      if (bodyOk && eyesOk && mouthOk) {
        storedSkinId = toStoredSkinId({
          bodyId: body.bodyId,
          eyesId: body.eyesId,
          mouthId: body.mouthId,
        });
      } else {
        storedSkinId = DEFAULT_SKIN_ID;
      }
    } else {
      const isTestAgent = DEV_MODE && apiKey.startsWith('test_');
      const requestedPreset = body.skinId && body.skinId in SKIN_PRESETS ? body.skinId : null;
      if (isTestAgent && requestedPreset) {
        storedSkinId = requestedPreset;
      } else {
        try {
          const ownedSkinIds = await getAgentSkins(agentInfo.name);
          const validOwnedSet = new Set(ownedSkinIds);
          if (body.skinId && validOwnedSet.has(body.skinId)) {
            storedSkinId = body.skinId;
          } else {
            storedSkinId = DEFAULT_SKIN_ID;
          }
        } catch (err) {
          console.error('[api] Failed to resolve owned skins, falling back to default:', err);
          storedSkinId = DEFAULT_SKIN_ID;
        }
      }
    }

    const result = matchManager.joinMatch(apiKey, agentInfo, body.displayName, body.color, storedSkinId ?? undefined);

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  });

  // GET /api/match/current - Requires auth
  router.get('/match/current', async (req: Request, res: Response) => {
    const apiKey = extractApiKey(req);
    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Missing Authorization header',
      });
      return;
    }

    const match = matchManager.getMatchState();
    if (!match) {
      res.status(404).json({
        success: false,
        error: 'NO_MATCH',
        message: 'No active match',
      });
      return;
    }

    // Find the player by API key
    const player = matchManager.getPlayerByApiKey(apiKey);
    const snake = player ? match.snakes.get(player.id) : undefined;

    const timeRemaining = Math.max(0, (match.endTime - Date.now()) / 1000);

    const response: GameStateResponse = {
      matchId: match.id,
      phase: match.phase,
      tick: match.tick,
      timeRemaining,
      arena: {
        width: ARENA_WIDTH,
        height: ARENA_HEIGHT,
      },
      you: snake
        ? (() => {
            const parts = resolveSkinToParts(snake.skinId);
            return {
              id: snake.id,
              bodyId: parts.bodyId,
              eyesId: parts.eyesId,
              mouthId: parts.mouthId,
              alive: snake.alive,
            x: snake.segments[0]?.x ?? 0,
            y: snake.segments[0]?.y ?? 0,
            angle: snake.angle,
            speed: snake.speed,
            boosting: snake.boosting,
            length: snake.segments.length,
            score: snake.score,
            segments: snake.segments.map(s => [s.x, s.y] as [number, number]),
            };
          })()
        : undefined,
      players: Array.from(match.snakes.values())
        .filter(s => s.id !== snake?.id)
        .map(s => {
          const parts = resolveSkinToParts(s.skinId);
          return {
            id: s.id,
            name: s.name,
            bodyId: parts.bodyId,
            eyesId: parts.eyesId,
            mouthId: parts.mouthId,
            alive: s.alive,
          x: s.segments[0]?.x ?? 0,
          y: s.segments[0]?.y ?? 0,
          angle: s.angle,
          speed: s.speed,
          boosting: s.boosting,
          length: s.segments.length,
          score: s.score,
          segments: s.segments.map(seg => [seg.x, seg.y] as [number, number]),
          killedBy: s.killedBy,
          deathTick: s.deathTick,
          };
        }),
      food: match.food.map(f => ({ x: f.x, y: f.y, value: f.value })),
      leaderboard: Array.from(match.snakes.values())
        .map(s => {
          const survivalMs = s.alive ? match.tick * TICK_INTERVAL : (s.deathTick ?? 0) * TICK_INTERVAL;
          return { id: s.id, name: s.name, score: s.score, survivalMs };
        })
        .sort((a, b) => b.survivalMs - a.survivalMs),
    };

    res.json(response);
  });

  // POST /api/match/action - Requires auth, rate limited
  router.post('/match/action', async (req: Request, res: Response) => {
    const apiKey = extractApiKey(req);
    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Missing Authorization header',
      });
      return;
    }

    // Check rate limit
    const rateCheck = checkRateLimit(apiKey);
    if (!rateCheck.allowed) {
      res.status(429).json({
        success: false,
        error: 'RATE_LIMITED',
        message: 'Max 5 actions per second',
        retryAfterMs: rateCheck.retryAfterMs,
      });
      return;
    }

    // Find the player
    const player = matchManager.getPlayerByApiKey(apiKey);
    if (!player) {
      res.status(400).json({
        success: false,
        error: 'NOT_IN_MATCH',
        message: 'You are not in an active match. Join first with POST /api/match/join',
      });
      return;
    }

    const body = req.body as ActionRequest;
    const result = matchManager.performAction(
      player.id,
      body.action,
      body.angle,
      body.angleDelta,
      body.boost,
      body.active
    );

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  });

  // GET /api/leaderboard - No auth required
  router.get('/leaderboard', (req: Request, res: Response) => {
    const leaderboard = matchManager.getLeaderboard();
    res.json(leaderboard);
  });

  // GET /api/global-leaderboard - No auth required
  router.get('/global-leaderboard', async (req: Request, res: Response) => {
    try {
      const data = await getGlobalLeaderboard();
      res.json(data);
    } catch (err) {
      console.error('[api] /api/global-leaderboard failed:', err);
      res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'Failed to load global leaderboard',
      });
    }
  });

  // GET /api/skins/options - No auth, list Body/Eyes/Mouth asset paths for client
  router.get('/skins/options', (req: Request, res: Response) => {
    try {
      const options = getSkinOptions();
      res.json(options);
    } catch (err) {
      console.error('[api] /api/skins/options failed:', err);
      res.status(500).json({
        bodies: [],
        eyes: [],
        mouths: [],
      });
    }
  });

  // GET /api/skins/preview - No auth, generate snake PNG from body/eyes/mouth IDs
  const previewCache = new Map<string, Buffer>();
  router.get('/skins/preview', async (req: Request, res: Response) => {
    const bodyId = typeof req.query.bodyId === 'string' ? req.query.bodyId : '';
    const eyesId = typeof req.query.eyesId === 'string' ? req.query.eyesId : '';
    const mouthId = typeof req.query.mouthId === 'string' ? req.query.mouthId : '';
    if (!bodyId || !eyesId || !mouthId) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Query params bodyId, eyesId, mouthId are required',
      });
      return;
    }
    try {
      const options = getSkinOptions();
      if (
        !options.bodies.includes(bodyId) ||
        !options.eyes.includes(eyesId) ||
        !options.mouths.includes(mouthId)
      ) {
        res.status(400).json({
          error: 'INVALID_PARTS',
          message: 'One or more of bodyId, eyesId, mouthId are not in available options',
        });
        return;
      }
      const cacheKey = `${bodyId}|${eyesId}|${mouthId}`;
      let buffer = previewCache.get(cacheKey);
      if (!buffer) {
        const { bodyPath, eyesPath, mouthPath } = getSkinPartPaths(bodyId, eyesId, mouthId);
        const result = await generateSnake(bodyPath, eyesPath, mouthPath);
        buffer = result.buffer;
        previewCache.set(cacheKey, buffer);
      }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(buffer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('skia-canvas')) {
        res.status(503).json({
          error: 'GENERATOR_UNAVAILABLE',
          message: 'Snake preview requires skia-canvas. Install with: npm install skia-canvas',
        });
        return;
      }
      console.error('[api] /api/skins/preview failed:', err);
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Failed to generate preview',
      });
    }
  });

  // GET /api/skins - No auth, preset skin IDs (for backward compat)
  router.get('/skins', (req: Request, res: Response) => {
    res.json({ skins: Object.keys(SKIN_PRESETS) });
  });

  // GET /api/agent/skins - Auth required, returns owned + all skins
  router.get('/agent/skins', async (req: Request, res: Response) => {
    const apiKey = extractApiKey(req);
    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Missing Authorization header',
      });
      return;
    }

    // Reuse API key verification from join route
    let agentInfo;
    if (DEV_MODE && apiKey.startsWith('test_')) {
      agentInfo = createTestAgent(apiKey.replace('test_', ''));
    } else {
      agentInfo = await verifyAgentApiKey(apiKey);
    }

    if (!agentInfo) {
      res.status(401).json({
        success: false,
        error: 'INVALID_API_KEY',
        message: 'Invalid Builder Arena API key. Use a key with ba_ prefix',
      });
      return;
    }

    try {
      const ownedIds = await getAgentSkins(agentInfo.name);
      const allPresetIds = Object.keys(SKIN_PRESETS);

      res.json({
        ownedSkins: ownedIds,
        allSkins: allPresetIds,
      });
    } catch (err) {
      console.error('[api] /api/agent/skins failed:', err);
      res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'Failed to load agent skins',
      });
    }
  });

  return router;
}
