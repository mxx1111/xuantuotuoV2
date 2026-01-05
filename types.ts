
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
  BETTING = 'betting', 
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

export interface KouLeChallengeEvent {
  initiator: PlayerId;
  challenger: PlayerId;
  challengerCollectedAtChallenge: number;
  targetCollected: number; // 9/15/18：宣后期望达到的下一档
}

export interface GameState {
  phase: GamePhase;
  hands: Record<PlayerId, Card[]>;
  collected: Record<PlayerId, Card[]>;
  table: Play[];
  turn: PlayerId;
  starter: PlayerId;
  starCoins: Record<PlayerId, number>;
  kouLeInitiator: PlayerId | null; // 当前正在进行的扣了发起者（仅在KOU_LE_DECISION阶段非空）
  challengers: Record<PlayerId, number>; // 本局内累计“宣”次数（用于UI展示）
  kouLeHistory: KouLeChallengeEvent[]; // 本局内所有“宣”的目标记录（用于结算）
  kouLeUsedThisTrick: boolean; // 本轮(当前一墩)是否已发起过“扣了”
  kouLeResponses: Record<PlayerId, 'agree' | 'challenge' | null>;
  logs: string[];
  aiNames: Record<string, string>;
  roundHistory: Play[][];
  nextStarter: PlayerId | null;
  multipliers: Record<PlayerId, number>; 
  grabber: PlayerId | null; 
  grabMultiplier: number; // 全局抢牌倍数 (1, 2, 4, 8...)
  betTurn: PlayerId | null; // 当前轮到谁进行博弈决策
  betResponses: Record<PlayerId, boolean>; 
}

export enum RewardLevel {
  BU_GOU = '不够',
  GANG_GOU = '刚够',
  WU_LE = '五了',
  CI_LE = '此了'
}

export type NetworkMessageType = 
  | 'SYNC_STATE' 
  | 'ACTION_PLAY' 
  | 'ACTION_KOU_LE_INIT' 
  | 'ACTION_KOU_LE_RES' 
  | 'ACTION_BET' 
  | 'START_GAME'
  | 'ERROR';

export interface NetworkMessage {
  type: NetworkMessageType;
  payload: any;
  senderId: string;
}
