// Arena dimensions
export const ARENA_WIDTH = 2000;
export const ARENA_HEIGHT = 2000;

// Snake settings: segment spacing +50% to match larger snake size
export const INITIAL_SNAKE_LENGTH = 3; // Fewer body parts
export const SNAKE_SEGMENT_SIZE = 18; // Base spacing for initial placement (12 * 1.5)
export const SEGMENT_SPACING_FRONT = 54; // Distance between segments near head (36 * 1.5; gap 54-27=27 < head 30)
export const SEGMENT_SPACING_TAIL = 18; // Distance near tail (12 * 1.5, kept smaller so tail doesn't separate)
export const NORMAL_SPEED = 10; // Units per tick (boost mechanic removed)

// Food settings
export const FOOD_VALUE = 10; // Points for eating regular food
export const DROPPED_FOOD_VALUE = 5; // Points for food dropped from death
export const MAX_FOOD_COUNT = 100; // Maintain this many food items in arena
export const FOOD_SPAWN_MARGIN = 50; // Don't spawn food too close to walls

// Collision: snake radii +50% from previous. Slip-through check: gap = SPACING_FRONT - 2*SEGMENT_RADIUS < 2*HEAD_RADIUS.
export const HEAD_RADIUS = 15; // Snake head (10 * 1.5)
export const SEGMENT_RADIUS = 13.5; // Body segments (9 * 1.5); gap 54-27=27 < 30 head diameter
export const FOOD_RADIUS = 3.375; // 25% smaller than previous 4.5 (visual + collision)
export const SELF_COLLISION_SKIP = 5; // Skip this many segments when checking self-collision

// Match settings
export const MATCH_DURATION = 4 * 60 * 1000; // 4 minutes in ms
export const LOBBY_DURATION = 90 * 1000; // 1.5 minute lobby before match
export const RESULTS_DURATION = 60 * 1000; // 60 seconds to show results
export const MATCH_INTERVAL = 5 * 60 * 1000; // New match every 5 minutes
export const MAX_PLAYERS = 10;
export const INSTANT_START_PLAYER_COUNT = 6; // Start immediately when this many players join

// Game loop
export const TICK_RATE = 20; // Ticks per second
export const TICK_INTERVAL = 1000 / TICK_RATE; // ms per tick

// Rate limiting
export const MAX_ACTIONS_PER_SECOND = 5;
