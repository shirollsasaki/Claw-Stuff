import { GameEngine } from './engine.js';
import { Player, MatchResult, AgentInfo, SpectatorGameState, SpectatorMatchEnd } from '../../shared/types.js';
import { resolveSkinToParts, SKIN_PRESETS } from '../../shared/skins.js';
import { recordAgentJoin, recordMatchEnd, getHighestMatchId } from '../db.js';
import {
  MATCH_DURATION,
  LOBBY_DURATION,
  RESULTS_DURATION,
  MATCH_INTERVAL,
  MAX_PLAYERS,
  TICK_INTERVAL,
  INSTANT_START_PLAYER_COUNT,
} from '../../shared/constants.js';
import * as bettingService from '../betting/service.js';
import { config } from '../config.js';

// In local/test mode use 90s start cooldown; production uses LOBBY_DURATION (also 90s)
const EFFECTIVE_LOBBY_DURATION = process.env.NODE_ENV === 'production' ? LOBBY_DURATION : 90 * 1000;

export class MatchManager {
  private engine: GameEngine;
  private players: Map<string, Player> = new Map();
  private matchHistory: MatchResult[] = [];
  private allTimeStats: Map<string, { wins: number; totalScore: number }> = new Map();
  private nextMatchId: number = 1;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private lobbyStartTimeout: NodeJS.Timeout | null = null;
  private bettingCloseTimeout: NodeJS.Timeout | null = null;
  private bettingOpenTimeout: NodeJS.Timeout | null = null;
  private bettingOpenedOnChain: boolean = false; // true once openBetting tx has been sent
  private resultsTimeout: NodeJS.Timeout | null = null;
  private currentMatchStartTime: number = 0;
  private nextMatchStartTime: number = 0;

  private onStateUpdateCallback: ((state: SpectatorGameState) => void) | null = null;
  private onMatchEndCallback: ((result: SpectatorMatchEnd) => void) | null = null;
  private onLobbyOpenCallback: ((matchId: string, startsAt: number) => void) | null = null;
  private onStatusChangeCallback: (() => void) | null = null;

  constructor() {
    this.engine = new GameEngine();
    this.engine.onTick((state) => {
      if (this.onStateUpdateCallback) {
        this.onStateUpdateCallback(state);
      }
    });
    this.engine.onMatchEnd((match) => {
      this.handleMatchEnd();
    });
  }

  // Start the match scheduler
  async start(): Promise<void> {
    // Initialize nextMatchId from database to persist across server restarts
    try {
      const highestId = await getHighestMatchId();
      this.nextMatchId = highestId + 1;
      console.log(`[MatchManager] Initialized nextMatchId to ${this.nextMatchId} (highest existing: ${highestId})`);
    } catch (err) {
      console.warn('[MatchManager] Failed to initialize nextMatchId from database, starting from 1:', err);
      this.nextMatchId = 1;
    }

    // Open a lobby immediately on server start
    console.log('Opening initial lobby...');
    this.openLobby();
  }

  stop(): void {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    if (this.lobbyStartTimeout) {
      clearTimeout(this.lobbyStartTimeout);
      this.lobbyStartTimeout = null;
    }
    if (this.bettingCloseTimeout) {
      clearTimeout(this.bettingCloseTimeout);
      this.bettingCloseTimeout = null;
    }
    if (this.bettingOpenTimeout) {
      clearTimeout(this.bettingOpenTimeout);
      this.bettingOpenTimeout = null;
    }
    this.bettingOpenedOnChain = false;
    if (this.resultsTimeout) {
      clearTimeout(this.resultsTimeout);
      this.resultsTimeout = null;
    }
    this.engine.stopMatch();
  }

  private openLobby(): void {
    // Don't open a new lobby if there's already an active match or lobby
    const match = this.engine.getMatch();
    if (match && match.phase !== 'finished') {
      console.log(`[openLobby] Skipping - match ${match.id} is still ${match.phase}`);
      return;
    }

    // Clear any pending timeouts from a previous match
    if (this.lobbyStartTimeout) {
      clearTimeout(this.lobbyStartTimeout);
      this.lobbyStartTimeout = null;
    }
    if (this.bettingCloseTimeout) {
      clearTimeout(this.bettingCloseTimeout);
      this.bettingCloseTimeout = null;
    }
    if (this.bettingOpenTimeout) {
      clearTimeout(this.bettingOpenTimeout);
      this.bettingOpenTimeout = null;
    }
    this.bettingOpenedOnChain = false;
    if (this.resultsTimeout) {
      clearTimeout(this.resultsTimeout);
      this.resultsTimeout = null;
    }

    const matchId = `match_${this.nextMatchId++}`;
    this.engine.createMatch(matchId);
    this.players.clear();

    // We don't know when this match will start until the first player joins.
    // Next match opens only after this match ends (so we don't know next times yet).
    this.currentMatchStartTime = 0;
    this.nextMatchStartTime = 0;

    console.log(`Lobby opened for ${matchId}. Waiting for first bot to join...`);

    if (this.onLobbyOpenCallback) {
      this.onLobbyOpenCallback(matchId, this.currentMatchStartTime);
    }

    if (this.onStatusChangeCallback) {
      this.onStatusChangeCallback();
    }

    // NOTE: Match start will be scheduled when the first player joins.
  }

  /**
   * Debounced betting open: waits 5s after the last player join before sending
   * a single openBetting tx with ALL agents. If a new player joins within
   * that window, the timer resets. This avoids multiple addAgents txs.
   */
  private scheduleBettingOpen(match: ReturnType<typeof this.engine.getMatch>): void {
    if (!match) return;
    const DEBOUNCE_MS = 5_000;

    // Gather all current agent names for the DB + emit (instant UI update)
    const allAgentNames = Array.from(match.snakes.values()).map(s => {
      const p = this.players.get(s.id);
      return p?.agentInfo.name ?? s.name;
    });

    if (!this.bettingOpenedOnChain) {
      // Haven't sent the on-chain tx yet – debounce it
      if (this.bettingOpenTimeout) clearTimeout(this.bettingOpenTimeout);

      // Update DB + emit immediately so the UI shows all agents right away
      if (config.bettingEnabled) {
        bettingService.openBettingForMatch(match.id, allAgentNames, false).catch(() => {});
      }

      this.bettingOpenTimeout = setTimeout(() => {
        this.bettingOpenTimeout = null;
        this.bettingOpenedOnChain = true;
        // Gather agents one final time in case more joined during debounce
        const finalMatch = this.engine.getMatch();
        if (!finalMatch) return;
        const finalNames = Array.from(finalMatch.snakes.values()).map(s => {
          const p = this.players.get(s.id);
          return p?.agentInfo.name ?? s.name;
        });
        // Update DB with final list, then send single on-chain tx
        if (config.bettingEnabled) {
          bettingService.openBettingForMatch(finalMatch.id, finalNames, true).catch(() => {});
        }
      }, DEBOUNCE_MS);
    } else {
      // openBetting already sent on-chain – add this agent via addAgents
      if (config.bettingEnabled) {
        bettingService.addBettingAgent(match.id, allAgentNames[allAgentNames.length - 1]).catch(() => {});
      }
    }
  }

  private startMatch(): void {
    const match = this.engine.getMatch();
    if (!match) return;

    // If debounced betting open hasn't fired yet, fire it now
    if (this.bettingOpenTimeout) {
      clearTimeout(this.bettingOpenTimeout);
      this.bettingOpenTimeout = null;
    }
    if (!this.bettingOpenedOnChain && match.snakes.size >= 2) {
      this.bettingOpenedOnChain = true;
      const allNames = Array.from(match.snakes.values()).map(s => {
        const p = this.players.get(s.id);
        return p?.agentInfo.name ?? s.name;
      });
      if (config.bettingEnabled) {
        bettingService.openBettingForMatch(match.id, allNames, true).catch(() => {});
      }
    }

    // Close betting if it wasn't already closed by the early timeout
    if (config.bettingEnabled) {
      bettingService.closeBettingForMatch(match.id).catch(() => {});
    }

    if (this.bettingCloseTimeout) {
      clearTimeout(this.bettingCloseTimeout);
      this.bettingCloseTimeout = null;
    }

    console.log(`Starting match ${match.id} with ${match.snakes.size} players`);
    this.engine.startMatch(MATCH_DURATION);
  }

  private handleMatchEnd(): void {
    const match = this.engine.getMatch();
    if (!match) return;

    // Rank by survival time first; if 2+ survived to the end, tiebreak by score/length
    const matchDurationMs = (match.actualEndTime ?? match.endTime) - match.startTime;
    const withSurvival = Array.from(match.snakes.values())
      .map(s => {
        const survivalMs = s.alive
          ? matchDurationMs
          : (s.deathTick ?? 0) * TICK_INTERVAL;
        return { name: s.name, score: s.score, kills: s.kills ?? 0, survivalMs };
      })
      .sort((a, b) => {
        if (b.survivalMs !== a.survivalMs) return b.survivalMs - a.survivalMs;
        return b.score - a.score;
      });
    const finalScores = withSurvival.map(({ name, score, kills }) => ({ name, score, kills }));
    // Map display name -> canonical agent name for DB (leaderboard uses agent_name)
    const displayNameToAgent = new Map<string, string>();
    // Also map canonical agent name -> API key (for agent reward wallet lookup)
    const agentNameToApiKey = new Map<string, string>();
    for (const snake of match.snakes.values()) {
      const player = this.players.get(snake.id);
      const agentName = player?.agentInfo.name ?? snake.name;
      displayNameToAgent.set(snake.name, agentName);
      if (player?.apiKey) {
        agentNameToApiKey.set(agentName, player.apiKey);
      }
    }
    const finalScoresForDb = finalScores.map(({ name, score, kills }) => ({
      agentName: displayNameToAgent.get(name) ?? name,
      score,
      kills,
    }));
    const winner = finalScores.length > 0 ? finalScores[0] : null;
    const winnerAgentName = winner ? (displayNameToAgent.get(winner.name) ?? winner.name) : null;

    // Add 1s to winner's displayed survival so they rank clearly first when game ends with one survivor (top 2 would otherwise tie)
    const WINNER_SURVIVAL_BONUS_MS = 1000;
    const finalScoresForSpectators = withSurvival.map((entry, i) => ({
      ...entry,
      survivalMs: entry.survivalMs + (i === 0 ? WINNER_SURVIVAL_BONUS_MS : 0),
    }));

    // Update all-time stats
    if (winner) {
      const stats = this.allTimeStats.get(winner.name) || { wins: 0, totalScore: 0 };
      stats.wins++;
      stats.totalScore += winner.score;
      this.allTimeStats.set(winner.name, stats);
    }

    for (const snake of match.snakes.values()) {
      if (snake.name !== winner?.name) {
        const stats = this.allTimeStats.get(snake.name) || { wins: 0, totalScore: 0 };
        stats.totalScore += snake.score;
        this.allTimeStats.set(snake.name, stats);
      }
    }

    // Record match result
    const endedAt = Date.now();
    const result: MatchResult = {
      matchId: match.id,
      endedAt,
      winner,
      playerCount: match.snakes.size,
      finalScores,
    };
    this.matchHistory.unshift(result);
    if (this.matchHistory.length > 50) {
      this.matchHistory.pop();
    }

    console.log(`Match ${match.id} ended. Winner: ${winner?.name || 'None'}`);

    // Persist to database (best-effort). Use canonical agent names so leaderboard wins match.
    recordMatchEnd({
      matchId: match.id,
      winnerAgentName: winnerAgentName,
      endedAt,
      finalScores: finalScoresForDb,
    }).catch(() => {});

    // ── Resolve betting ────────────────────────────────────────────────
    // Detect draws: multiple agents with top survival time
    const topSurvival = withSurvival.length > 0 ? withSurvival[0].survivalMs : 0;
    const drawThresholdMs = 50; // consider equal if within 50ms
    const winners = withSurvival.filter(e => Math.abs(e.survivalMs - topSurvival) <= drawThresholdMs);
    const isDraw = winners.length > 1;
    const winnerAgentNames = winners.map(w => displayNameToAgent.get(w.name) ?? w.name);
    // Look up wallet addresses for winner agents (best-effort, may be null)
    const winnerWalletPromises = winnerAgentNames.map(name => {
      const apiKey = agentNameToApiKey.get(name);
      if (!apiKey) return Promise.resolve(null);
      if (config.bettingEnabled) {
        return bettingService.getAgentWallet(name, apiKey).catch(() => null);
      }
      return Promise.resolve(null);
    });
    Promise.all(winnerWalletPromises).then(wallets => {
      if (config.bettingEnabled) {
        const winnerAgentWallets = wallets.map(w => w || '0x0000000000000000000000000000000000000000');
        bettingService.resolveMatchBetting({
          matchId: match.id,
          winnerAgentNames,
          winnerAgentWallets,
          isDraw,
        }).catch(err => console.error('[MatchManager] resolveMatchBetting failed:', err));
      }
    }).catch(() => {});

    // Notify spectators (include winner skin + survival time for display)
    if (this.onMatchEndCallback) {
      const winnerEntry = withSurvival[0] ?? null;
      type WinnerWithSkin = SpectatorMatchEnd['winner'];
      let winnerWithSkin: WinnerWithSkin = winnerEntry
        ? { name: winnerEntry.name, score: winnerEntry.score, survivalMs: winnerEntry.survivalMs + WINNER_SURVIVAL_BONUS_MS }
        : null;
      if (winnerWithSkin) {
        const winnerSnake = Array.from(match.snakes.values()).find(s => s.name === winnerWithSkin!.name);
        if (winnerSnake) {
          const parts = resolveSkinToParts(winnerSnake.skinId);
          winnerWithSkin = { ...winnerWithSkin, bodyId: parts.bodyId, eyesId: parts.eyesId, mouthId: parts.mouthId };
        }
      }
      this.onMatchEndCallback({
        matchId: match.id,
        winner: winnerWithSkin,
        finalScores: finalScoresForSpectators,
        nextMatchStartsAt: this.nextMatchStartTime,
      });
    }

    // Schedule the next lobby to open after the results period
    // This ensures we don't interrupt an active match with a new lobby
    if (this.resultsTimeout) {
      clearTimeout(this.resultsTimeout);
    }
    this.resultsTimeout = setTimeout(() => {
      this.openLobby();
    }, RESULTS_DURATION);
  }

  // Player management
  joinMatch(
    apiKey: string,
    agentInfo: AgentInfo,
    displayName?: string,
    color?: string,
    skinId?: string,
  ): {
    success: boolean;
    playerId?: string;
    matchId?: string;
    message: string;
    startsAt?: number;
    error?: string;
  } {
    const match = this.engine.getMatch();
    if (!match) {
      return {
        success: false,
        message: 'No active match lobby',
        error: 'NO_LOBBY',
      };
    }

    if (match.phase !== 'lobby') {
      return {
        success: false,
        message: 'Match already in progress. Wait for next match.',
        error: 'MATCH_IN_PROGRESS',
      };
    }

    if (match.snakes.size >= MAX_PLAYERS) {
      return {
        success: false,
        message: `Match lobby is full (${MAX_PLAYERS}/${MAX_PLAYERS} players)`,
        error: 'LOBBY_FULL',
      };
    }

    // Check if already joined
    for (const player of this.players.values()) {
      if (player.apiKey === apiKey) {
        return {
          success: false,
          message: 'You have already joined this match',
          error: 'ALREADY_JOINED',
        };
      }
    }

    const wasFirst = match.snakes.size === 0;
    const isSecond = match.snakes.size === 1;
    const playerCountAfterJoin = match.snakes.size + 1;

    // Create player
    const playerId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const name = displayName || agentInfo.name;

    // If no skin was provided, assign a random preset skin
    if (!skinId) {
      const presetIds = Object.keys(SKIN_PRESETS);
      if (presetIds.length > 0) {
        const idx = Math.floor(Math.random() * presetIds.length);
        skinId = presetIds[idx];
      }
    }

    const snake = this.engine.addPlayer(playerId, name, color, skinId);
    if (!snake) {
      return {
        success: false,
        message: 'Failed to join match',
        error: 'JOIN_FAILED',
      };
    }

    const player: Player = {
      id: playerId,
      agentInfo,
      apiKey,
      lastActionTime: 0,
      actionCount: 0,
    };
    this.players.set(playerId, player);

    // Start countdown when the second bot joins, or start immediately when 6 players join
    if (isSecond || playerCountAfterJoin === INSTANT_START_PLAYER_COUNT) {
      const now = Date.now();
      const delay = playerCountAfterJoin >= INSTANT_START_PLAYER_COUNT ? 0 : EFFECTIVE_LOBBY_DURATION;
      this.currentMatchStartTime = now + delay;
      this.nextMatchStartTime = this.currentMatchStartTime + MATCH_DURATION + RESULTS_DURATION;

      if (this.lobbyStartTimeout) {
        clearTimeout(this.lobbyStartTimeout);
      }
      this.lobbyStartTimeout = setTimeout(() => this.startMatch(), delay);

      // Close betting 10s before match starts so late bets have time to mine
      const BETTING_CLOSE_BUFFER = 10_000; // 10 seconds
      if (EFFECTIVE_LOBBY_DURATION > BETTING_CLOSE_BUFFER) {
        if (this.bettingCloseTimeout) clearTimeout(this.bettingCloseTimeout);
        this.bettingCloseTimeout = setTimeout(() => {
          const m = this.engine.getMatch();
          if (m && config.bettingEnabled) {
            bettingService.closeBettingForMatch(m.id).catch(() => {});
          }
        }, EFFECTIVE_LOBBY_DURATION - BETTING_CLOSE_BUFFER);
      }

      // Schedule betting open (debounced – see below)
      this.scheduleBettingOpen(match);

      console.log(
        EFFECTIVE_LOBBY_DURATION > 0
          ? `Second bot joined lobby for ${match.id}. Match will start in ${EFFECTIVE_LOBBY_DURATION / 1000}s (at ${new Date(this.currentMatchStartTime).toISOString()}).`
          : `Second bot joined lobby for ${match.id}. Starting match immediately (local test mode).`,
      );
    } else if (wasFirst) {
      console.log(`First bot joined lobby for ${match.id}. Waiting for another bot to join before countdown.`);
    } else if (match.snakes.size >= 2) {
      // Another player joined – reschedule/extend the debounce so they're included
      this.scheduleBettingOpen(match);
    }

    // Persist agent + match participation (best-effort)
    recordAgentJoin({
      agentName: agentInfo.name,
      apiKey,
      playerId,
      matchId: match.id,
      color,
      skinId: skinId ?? undefined,
    }).catch(() => {});

    const timeUntilStart = Math.max(0, this.currentMatchStartTime - Date.now());

    // Notify listeners (e.g. WebSocket spectators) that status changed (playerCount)
    if (this.onStatusChangeCallback) {
      this.onStatusChangeCallback();
    }

    const message =
      this.currentMatchStartTime > 0
        ? `Joined lobby. Match starts in ${Math.round(timeUntilStart / 1000)} seconds.`
        : 'Joined lobby. Waiting for another bot to join before countdown starts.';

    return {
      success: true,
      playerId,
      matchId: match.id,
      message,
      startsAt: this.currentMatchStartTime,
    };
  }

  getPlayerByApiKey(apiKey: string): Player | undefined {
    for (const player of this.players.values()) {
      if (player.apiKey === apiKey) {
        return player;
      }
    }
    return undefined;
  }

  // Game actions
  performAction(
    playerId: string,
    action: 'steer' | 'boost',
    angle?: number,
    angleDelta?: number,
    boost?: boolean,
    active?: boolean
  ): {
    success: boolean;
    tick?: number;
    newAngle?: number;
    boosting?: boolean;
    speed?: number;
    length?: number;
    error?: string;
    message?: string;
  } {
    const match = this.engine.getMatch();
    if (!match || match.phase !== 'active') {
      return {
        success: false,
        error: 'NO_ACTIVE_MATCH',
        message: 'No active match',
      };
    }

    const snake = this.engine.getPlayerState(playerId);
    if (!snake) {
      return {
        success: false,
        error: 'NOT_IN_MATCH',
        message: 'You are not in an active match',
      };
    }

    if (!snake.alive) {
      return {
        success: false,
        error: 'DEAD',
        message: 'Your snake is dead. Wait for next match.',
      };
    }

    // Handle steering
    if (action === 'steer' || angle !== undefined || angleDelta !== undefined) {
      this.engine.steerPlayer(playerId, angle, angleDelta);
    }

    const updatedSnake = this.engine.getPlayerState(playerId)!;
    return {
      success: true,
      tick: match.tick,
      newAngle: updatedSnake.angle,
      boosting: false,
      speed: updatedSnake.speed,
      length: updatedSnake.segments.length,
    };
  }

  // State getters
  getMatchState() {
    return this.engine.getMatch();
  }

  getSpectatorState() {
    const match = this.engine.getMatch();
    if (!match) return null;
    return this.engine.getSpectatorState();
  }

  getStatus() {
    const match = this.engine.getMatch();
    const now = Date.now();

    // Next match times are only known once the current match is scheduled (first player joined).
    // When in lobby with 0 players, next match opens after this match runs.
    const hasNextMatchTimes = this.nextMatchStartTime > 0;

    return {
      serverTime: now,
      currentMatch: match
        ? {
            id: match.id,
            phase: match.phase,
            // For lobby phase, use scheduled start time (0 until first player joins); for active, use actual startTime
            startsAt: match.phase === 'lobby' ? this.currentMatchStartTime : match.startTime,
            startedAt: match.startTime,
            endsAt: match.endTime,
            playerCount: match.snakes.size,
            // In lobby, include joined bot names for the spectator UI
            lobbyPlayers: match.phase === 'lobby'
              ? Array.from(match.snakes.values()).map(s => s.name)
              : undefined,
          }
        : null,
      nextMatch: {
        id: `match_${this.nextMatchId}`,
        // When current match is in lobby with no players, we don't know when next match will open
        lobbyOpensAt: hasNextMatchTimes ? this.nextMatchStartTime - EFFECTIVE_LOBBY_DURATION : 0,
        startsAt: hasNextMatchTimes ? this.nextMatchStartTime : 0,
      },
    };
  }

  getLeaderboard() {
    const allTime = Array.from(this.allTimeStats.entries())
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.wins - a.wins || b.totalScore - a.totalScore)
      .slice(0, 20);

    const recentMatches = this.matchHistory.slice(0, 10).map(m => ({
      matchId: m.matchId,
      endedAt: m.endedAt,
      winner: m.winner,
      playerCount: m.playerCount,
    }));

    return { allTime, recentMatches };
  }

  // Event callbacks
  onStateUpdate(callback: (state: SpectatorGameState) => void): void {
    this.onStateUpdateCallback = callback;
  }

  onMatchEndEvent(callback: (result: SpectatorMatchEnd) => void): void {
    this.onMatchEndCallback = callback;
  }

  onLobbyOpen(callback: (matchId: string, startsAt: number) => void): void {
    this.onLobbyOpenCallback = callback;
  }

  onStatusChange(callback: () => void): void {
    this.onStatusChangeCallback = callback;
  }
}
