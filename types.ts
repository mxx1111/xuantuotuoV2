
export type Color = 'red' | 'black' | 'none';

export type CardName = '卒' | '马' | '相' | '尔' | '曲' | '大王' | '小王';

export interface Card {
  id: string;
  name: CardName;
  color: Color;
  value: string; 
  suit: string; 
  strength: number;
}

export enum PlayerId {
  PLAYER = 'player',
  AI_LEFT = 'ai_left',
  AI_RIGHT = 'ai_right'
}

export enum GamePhase {
  LOBBY = 'lobby',
  WAITING = 'waiting',
  DEALING = 'dealing',
  PLAYING = 'playing',
  ROUND_OVER = 'round_over',
  KOU_LE_DECISION = 'kou_le_decision',
  SETTLEMENT = 'settlement'
}

export interface Play {
  playerId: PlayerId;
  cards: Card[];
  type: 'single' | 'pair' | 'triple' | 'discard';
  strength: number;
}

export interface GameState {
  phase: GamePhase;
  hands: Record<PlayerId, Card[]>;
  collected: Record<PlayerId, Card[]>;
  table: Play[];
  turn: PlayerId;
  starter: PlayerId;
  starCoins: Record<PlayerId, number>;
  kouLeInitiator: PlayerId | null;
  challengers: PlayerId[]; 
  kouLeResponses: Record<PlayerId, 'agree' | 'challenge' | null>;
  logs: string[];
  aiNames: Record<string, string>;
  roundHistory: Play[][];
  nextStarter: PlayerId | null;
}

export enum RewardLevel {
  BU_GOU = '不够',
  GANG_GOU = '刚够',
  WU_LE = '五了',
  CI_LE = '此了'
}

// 联机消息
export type NetworkMessageType = 
  | 'SYNC_STATE' 
  | 'ACTION_PLAY' 
  | 'ACTION_KOU_LE_INIT' 
  | 'ACTION_KOU_LE_RES' 
  | 'START_GAME';

export interface NetworkMessage {
  type: NetworkMessageType;
  payload: any;
  senderId: string;
}
