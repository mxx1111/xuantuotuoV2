# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**宣坨坨 (Xuantuotuo)** - A web-based implementation of a traditional poker card game from Liulin, Shanxi Province, China. This is a 3-player game with a unique 24-card deck system featuring special card combinations and betting mechanics.

### Technology Stack

- **React 19.2.3** - UI framework
- **TypeScript 5.8.2** - Type safety
- **Vite 6.2.0** - Build tool and dev server
- **TailwindCSS** - Styling (via CDN)
- **PeerJS 1.5.2** - WebRTC-based peer-to-peer networking
- **Web Audio API** - Sound effects engine

## Development Commands

```bash
# Install dependencies
npm install

# Start development server (http://localhost:5173)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Architecture

### Core Game Logic

The game state management is centralized in `App.tsx` using React hooks. The architecture follows a single-source-of-truth pattern where all game state flows through the `GameState` interface.

**Key architectural patterns:**

1. **State Machine**: Game progresses through defined phases (LOBBY → DEALING → BETTING → PLAYING → SETTLEMENT)
2. **AI Decision Engine**: Separate pure functions in `gameLogic.ts` handle AI behavior
3. **Networking Layer**: PeerJS handles P2P connections with a host-client model
4. **Sound Engine**: Custom Web Audio synthesis (no external audio files)

### File Structure

```
├── App.tsx                  # Main game component (1600+ lines)
│   ├── Game state management
│   ├── Networking (PeerJS)
│   ├── AI logic integration
│   └── UI rendering
├── types.ts                 # TypeScript interfaces and enums
│   ├── Card, Play, GameState
│   ├── GamePhase enum
│   └── Network message types
├── gameLogic.ts            # Pure game logic functions
│   ├── calculatePlayStrength()
│   ├── getValidPlays()
│   ├── AI decision functions
│   └── Reward calculation
├── constants.tsx           # Deck definition and game constants
│   └── createDeck() - 24-card deck builder
├── components/
│   └── PlayingCard.tsx     # Card rendering component
├── index.tsx               # React entry point
├── index.html              # HTML with embedded styles
└── vite.config.ts          # Vite configuration
```

### Game State Flow

**Single-Player Mode:**
- Player vs 2 AI opponents
- All game logic runs client-side
- AI uses decision algorithms from `gameLogic.ts`

**Multiplayer Mode (P2P):**
- Host-client architecture via PeerJS
- Host maintains authoritative game state
- State synchronized via `broadcast()` function
- Message types: SYNC_STATE, ACTION_PLAY, ACTION_KOU_LE_INIT, etc.

### Card System

The game uses a unique 24-card deck (defined in `constants.tsx`):
- **卒 (Zu)** - Value 7, Strength 17-18
- **马 (Ma)** - Value 8, Strength 19-20
- **相 (Xiang)** - Value 9, Strength 21-22
- **尔 (Er)** - Value 10, Strength 23-24
- **曲 (Qu)** - J/Q/K, Strength 14-16
- **大王/小王 (Jokers)** - Strength 14-16

Card strength determines play order. Special combinations:
- **Pairs**: Same name + same color (strength + 100)
- **Triples**: Three 曲 of same color (strength + 200)
- **Special pairs**: 大王+小王 or 红尔+红尔 (strength 125)

### AI Implementation

AI decision-making is deterministic based on hand strength scoring:
- `aiDecidePlay()` - Choose which cards to play
- `aiDecideBet()` - Betting/grabbing decisions
- `aiEvaluateKouLe()` - Response to "扣了" (challenge) decisions

AI evaluates hand strength by counting:
- Top cards (strength ≥ 22)
- Valid pairs and triples
- Collected card count

### Sound System

Custom sound synthesis using Web Audio API (no external files):
- `SoundEngine.play(type)` - Generates tones for game events
- Sound types: deal, play, win, settle, victory, defeat, shuffle, bet, grab
- Uses oscillators with different waveforms (sine, square, triangle, sawtooth)

## Common Development Patterns

### Adding a New Game Phase

1. Add enum value to `GamePhase` in `types.ts`
2. Update state machine logic in `App.tsx`
3. Add UI rendering for the phase
4. Add network synchronization if needed (in `handleNetworkMessage`)

### Modifying Game Rules

All core game logic is in `gameLogic.ts`. Key functions:
- `calculatePlayStrength()` - Determines if cards form valid plays
- `getValidPlays()` - Returns all legal moves
- `getRewardInfo()` - Maps collected cards to star coin rewards

### Adding Network Messages

1. Define type in `NetworkMessageType` union (types.ts)
2. Create interface extending `NetworkMessage`
3. Add handler in `handleNetworkMessage()` function
4. Use `broadcast()` for host→all or `sendToHost()` for client→host

## Important Notes

### Networking Model
- **Host** (isHost=true) runs authoritative game state
- **Clients** receive state updates via SYNC_STATE messages
- Clients send actions (ACTION_PLAY, ACTION_BET, etc.) to host
- Host processes actions and broadcasts new state

### State Synchronization
When modifying game state in multiplayer:
```typescript
setGameState(prev => {
  const newState = { /* updated state */ };
  if (isHost) broadcast('SYNC_STATE', newState);
  return newState;
});
```

### Development Server
PeerJS requires HTTPS in production but works with HTTP in development (localhost).

### Import Map
The project uses an import map in `index.html` for React imports. This is compatible with Vite's module resolution.

## Testing

No automated tests are currently configured. Manual testing workflow:
1. Start dev server: `npm run dev`
2. Test single-player: Click "单机模式"
3. Test multiplayer: Open two browser windows, use Room ID to connect
4. Verify game phases transition correctly
5. Check sound effects play on actions

## Building and Deployment

```bash
npm run build
```

Output directory: `dist/`

The built app is a static SPA that can be deployed to any static hosting:
- Vercel, Netlify, GitHub Pages
- Traditional web servers (nginx, Apache)
- CDN with static hosting

**Requirements:**
- Must serve `index.html` for all routes (SPA fallback)
- PeerJS requires HTTPS in production (or use custom PeerJS server)

## Configuration

### Vite Config (`vite.config.ts`)
- React plugin enabled
- Output: `dist/`
- Sourcemaps disabled in production

### TypeScript Config (`tsconfig.json`)
- Target: ES2022
- JSX: react-jsx
- Module resolution: bundler
- Path alias: `@/*` → `./*`

### Styling
TailwindCSS loaded via CDN in `index.html` with custom config:
- Custom font families: Noto Serif SC, Inter
- Extended animations for card dealing/playing
- Custom scrollbar styles

## Code Conventions

### Type Safety
All game entities are strongly typed via interfaces in `types.ts`. Use type guards when handling network messages or user input.

### Immutability
State updates use immutable patterns:
```typescript
setGameState(prev => ({ ...prev, field: newValue }))
```

### Function Organization
- **Pure functions** → `gameLogic.ts`
- **State management** → `App.tsx` (hooks and effects)
- **UI components** → `components/`
- **Constants** → `constants.tsx`

### Naming Conventions
- React components: PascalCase
- Functions: camelCase
- Constants: UPPER_SNAKE_CASE
- Type definitions: PascalCase
- Chinese game terms preserved in logs and UI

## Game-Specific Terminology

- **宣坨坨 (Xuantuotuo)**: Game name
- **扣了 (Kou Le)**: Challenge mechanism where a player can end the round early
- **抢牌 (Qiang Pai)**: Card grabbing/betting phase
- **星光币 (Star Coins)**: In-game currency
- **收牌 (Shou Pai)**: Collecting cards from the table
- **不够/刚够/五了/此了**: Reward levels based on collected cards (9/15/18 thresholds)
