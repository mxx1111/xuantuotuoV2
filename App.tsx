import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { 
  Card, PlayerId, GamePhase, GameState, Play, 
  RewardLevel, NetworkMessage, NetworkMessageType 
} from './types';
import { 
  createDeck, INITIAL_STAR_COINS 
} from './constants';
import { 
  calculatePlayStrength, getValidPlays, getRewardInfo, 
  aiDecidePlay, aiEvaluateKouLe, aiDecideBet,
  getKouLeChallengeTarget,
  checkNoXiang 
} from './gameLogic';
import PlayingCard from './components/PlayingCard';

declare var Peer: any;

const SoundEngine = {
  ctx: null as AudioContext | null,
  init() {
    if (!this.ctx) this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  play(type: 'deal' | 'play' | 'win' | 'settle' | 'victory' | 'defeat' | 'shuffle' | 'bet' | 'grab') {
    this.init();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const playTone = (freq: number, startTime: number, duration: number, volume: number, type: OscillatorType = 'sine') => {
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(volume, startTime);
      gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
      osc.connect(gain);
      gain.connect(this.ctx!.destination);
      osc.start(startTime);
      osc.stop(startTime + duration);
    };
    switch(type) {
      case 'shuffle': 
        for(let i=0; i<8; i++) playTone(200 + i*80, now + i*0.1, 0.15, 0.05, 'sawtooth');
        break;
      case 'deal': playTone(600, now, 0.1, 0.1); break;
      case 'play': playTone(150, now, 0.1, 0.1, 'square'); break;
      case 'win': playTone(800, now, 0.2, 0.1); break;
      case 'settle': playTone(400, now, 0.5, 0.1); break;
      case 'grab': 
        playTone(440, now, 0.1, 0.1, 'triangle');
        playTone(880, now + 0.1, 0.2, 0.1, 'triangle');
        break;
      case 'victory': [523.25, 659.25, 783.99, 1046.50].forEach((f, i) => playTone(f, now + i * 0.15, 0.4, 0.1, 'triangle')); break;
      case 'defeat': [349.23, 293.66, 261.63, 196.00].forEach((f, i) => playTone(f, now + i * 0.2, 0.6, 0.1, 'sawtooth')); break;
      case 'bet': playTone(1000, now, 0.1, 0.05, 'sine'); break;
    }
  }
};

const AI_SURNAME_POOL = ['王', '李', '赵', '孙', '钱', '周', '吴', '郑', '刘', '马', '张', '贾', '欧阳', '司徒', '夏', '唐', '韩', '程', '杜', '左', '宁', '赫', '尹', '冯', '黎', '闫', '高', '许', '陶', '云', '莫'];
const AI_TITLE_POOL = ['铁柱', '翠花', '大壮', '木耳', '多多', '神算', '机灵', '大胆', '不怂', '半仙', '飞侠', '小胖', '犯困', '多嘴', '讲究', '三思', '开挂', '有料', '提神', '摸鱼', '冲浪', '老炮', '扛把子', '掌门', '补锅匠', '妙手', '火箭', '不求人', '稳住哥', '夜行人', '大聪明', '一根筋', '旺财', '闪电', '藏龙', '追风', '神聊', '机灵鬼'];

const getRandomInt = (max: number): number => {
  if (max <= 0) return 0;
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const randomArray = new Uint32Array(1);
    crypto.getRandomValues(randomArray);
    return randomArray[0] % max;
  }
  return Math.floor(Math.random() * max);
};

const pickAiName = (used: string[]): string => {
  const totalCombos = AI_SURNAME_POOL.length * AI_TITLE_POOL.length;
  for (let attempt = 0; attempt < totalCombos; attempt++) {
    const surname = AI_SURNAME_POOL[getRandomInt(AI_SURNAME_POOL.length)];
    const title = AI_TITLE_POOL[getRandomInt(AI_TITLE_POOL.length)];
    const combo = `${surname}${title}`;
    if (!used.includes(combo)) {
      return combo;
    }
  }
  return `神秘AI${Math.floor(Math.random() * 900 + 100)}`;
};

interface SlotInfo {
  type: 'empty' | 'human' | 'ai';
  peerId?: string;
  name: string;
}

const ALL_PLAYER_IDS: PlayerId[] = [PlayerId.PLAYER, PlayerId.AI_LEFT, PlayerId.AI_RIGHT];
const SEAT_ORDER_CLOCKWISE: PlayerId[] = [PlayerId.PLAYER, PlayerId.AI_RIGHT, PlayerId.AI_LEFT];

const INITIAL_GAME_STATE = (starCoins?: Record<PlayerId, number>): GameState => ({
  phase: GamePhase.LOBBY,
  hands: { [PlayerId.PLAYER]: [], [PlayerId.AI_LEFT]: [], [PlayerId.AI_RIGHT]: [] },
  collected: { [PlayerId.PLAYER]: [], [PlayerId.AI_LEFT]: [], [PlayerId.AI_RIGHT]: [] },
  table: [],
  turn: PlayerId.PLAYER,
  starter: PlayerId.PLAYER,
  starCoins: starCoins || { [PlayerId.PLAYER]: INITIAL_STAR_COINS, [PlayerId.AI_LEFT]: INITIAL_STAR_COINS, [PlayerId.AI_RIGHT]: INITIAL_STAR_COINS },
  kouLeInitiator: null,
  challengers: { [PlayerId.PLAYER]: 0, [PlayerId.AI_LEFT]: 0, [PlayerId.AI_RIGHT]: 0 },
  kouLeHistory: [],
  kouLeUsedThisTrick: false,
  kouLeResponses: { [PlayerId.PLAYER]: null, [PlayerId.AI_LEFT]: null, [PlayerId.AI_RIGHT]: null },
  logs: ['系统: 宣坨坨已就绪。'],
  aiNames: { [PlayerId.AI_LEFT]: 'AI 左', [PlayerId.AI_RIGHT]: 'AI 右' },
  roundHistory: [],
  nextStarter: null,
  multipliers: { [PlayerId.PLAYER]: 1, [PlayerId.AI_LEFT]: 1, [PlayerId.AI_RIGHT]: 1 },
  grabber: null,
  grabMultiplier: 1,
  betTurn: null,
  betResponses: { [PlayerId.PLAYER]: false, [PlayerId.AI_LEFT]: false, [PlayerId.AI_RIGHT]: false }
});

const buildHiddenCard = (id: string): Card => ({
  id,
  name: '卒',
  color: 'none',
  value: '?',
  suit: '?',
  strength: 0,
});

const buildHiddenCards = (count: number, prefix: string): Card[] => {
  if (count <= 0) return [];
  return Array.from({ length: count }, (_, i) => buildHiddenCard(`${prefix}-${i}`));
};

const maskPlayForPublicView = (play: Play): Play => {
  if (play.type !== 'discard') return play;
  return {
    ...play,
    cards: buildHiddenCards(play.cards.length, `hidden-discard-${play.playerId}`),
  };
};

const buildSyncedStateForSeat = (state: GameState, seat: PlayerId): GameState => {
  const hands: Record<PlayerId, Card[]> = {
    [PlayerId.PLAYER]: buildHiddenCards(state.hands[PlayerId.PLAYER].length, `hidden-hand-${PlayerId.PLAYER}`),
    [PlayerId.AI_LEFT]: buildHiddenCards(state.hands[PlayerId.AI_LEFT].length, `hidden-hand-${PlayerId.AI_LEFT}`),
    [PlayerId.AI_RIGHT]: buildHiddenCards(state.hands[PlayerId.AI_RIGHT].length, `hidden-hand-${PlayerId.AI_RIGHT}`),
  };
  hands[seat] = state.hands[seat];

  const collected: Record<PlayerId, Card[]> = {
    [PlayerId.PLAYER]: buildHiddenCards(state.collected[PlayerId.PLAYER].length, `hidden-collected-${PlayerId.PLAYER}`),
    [PlayerId.AI_LEFT]: buildHiddenCards(state.collected[PlayerId.AI_LEFT].length, `hidden-collected-${PlayerId.AI_LEFT}`),
    [PlayerId.AI_RIGHT]: buildHiddenCards(state.collected[PlayerId.AI_RIGHT].length, `hidden-collected-${PlayerId.AI_RIGHT}`),
  };

  return {
    ...state,
    hands,
    collected,
    table: state.table.map(maskPlayForPublicView),
    roundHistory: state.roundHistory.map(trick => trick.map(maskPlayForPublicView)),
  };
};

const generateRoomCode = (): string => {
  return String(Math.floor(Math.random() * 9000) + 1000);
};

const App: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>(INITIAL_GAME_STATE());
  const [myId, setMyId] = useState<string>('');
  const [targetId, setTargetId] = useState<string>('');
  const [hostPeerId, setHostPeerId] = useState<string>('');
  const [isHost, setIsHost] = useState<boolean>(false);
  const [myPlayerId, setMyPlayerId] = useState<PlayerId>(PlayerId.PLAYER);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [showRules, setShowRules] = useState<boolean>(false);
  const [showJoinModal, setShowJoinModal] = useState<boolean>(false);
  const [myNickname, setMyNickname] = useState<string>('');
  const normalizedNickname = useMemo(() => myNickname.trim().slice(0, 12), [myNickname]);
  const isNicknameReady = normalizedNickname.length > 0;
  
  const [slots, setSlots] = useState<Record<PlayerId, SlotInfo>>({
    [PlayerId.PLAYER]: { type: 'human', name: '房主' },
    [PlayerId.AI_LEFT]: { type: 'empty', name: '等待加入...' },
    [PlayerId.AI_RIGHT]: { type: 'empty', name: '等待加入...' },
  });

  const peerRef = useRef<any>(null);
  const connectionsRef = useRef<Record<string, any>>({});
  const gameStateRef = useRef<GameState>(gameState);
  const slotsRef = useRef<Record<PlayerId, SlotInfo>>(slots);
  const isHostRef = useRef<boolean>(isHost);
  const myPlayerIdRef = useRef<PlayerId>(myPlayerId);
  const hostPeerIdRef = useRef<string>(hostPeerId);
  const autoJoinRoomRef = useRef<string>('');
  const handleNetworkMessageRef = useRef<(msg: NetworkMessage, remotePeerId?: string) => void>(() => {});
  const [selectedCards, setSelectedCards] = useState<Card[]>([]);
  const [hoverCardId, setHoverCardId] = useState<string | null>(null);
  const [isTouchDevice, setIsTouchDevice] = useState<boolean>(false);
  const updatedCoinsForRound = useRef<boolean>(false);

  useEffect(() => { gameStateRef.current = gameState; }, [gameState]);
  useEffect(() => { slotsRef.current = slots; }, [slots]);
  useEffect(() => { isHostRef.current = isHost; }, [isHost]);
  useEffect(() => { myPlayerIdRef.current = myPlayerId; }, [myPlayerId]);
  useEffect(() => { hostPeerIdRef.current = hostPeerId; }, [hostPeerId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const touchDetected = (('ontouchstart' in window) || navigator.maxTouchPoints > 0 || window.matchMedia?.('(pointer: coarse)').matches);
    setIsTouchDevice(Boolean(touchDetected));
  }, []);

  const getPlayerName = useCallback((pid: PlayerId) => {
    if (pid === myPlayerId) {
      return isNicknameReady ? `我（${normalizedNickname}）` : '我';
    }
    const slot = slots[pid];
    if (!slot) return '';
    if (slot.type === 'ai') return slot.name || gameState.aiNames[pid] || 'AI';
    return slot.name;
  }, [myPlayerId, slots, gameState.aiNames, normalizedNickname, isNicknameReady]);

  const orientation = useMemo(() => {
    const idx = SEAT_ORDER_CLOCKWISE.indexOf(myPlayerId);
    const safeIdx = idx === -1 ? 0 : idx;
    const rotate = (offset: number) => SEAT_ORDER_CLOCKWISE[(safeIdx + offset) % SEAT_ORDER_CLOCKWISE.length];
    const bottom = rotate(0);
    const topRight = rotate(1);
    const topLeft = rotate(2);
    return {
      bottom,
      topLeft,
      topRight,
      waitingOrder: [topLeft, bottom, topRight] as PlayerId[]
    };
  }, [myPlayerId]);

  const displayNickname = useMemo(() => {
    if (isNicknameReady) return normalizedNickname;
    const slotName = slots[myPlayerId]?.name?.trim();
    return slotName || '侠客';
  }, [normalizedNickname, isNicknameReady, slots, myPlayerId]);

  const playerHandSorted = useMemo(() => {
    const hand = [...gameState.hands[myPlayerId]];

    // 特殊排序规则：
    // 当手牌同时包含“大王”和“小王”时，避免被“曲(14/16)”拆开：
    // 先排黑/红曲曲，再把大小王挨着放在曲曲后面。
    const hasBigJoker = hand.some(c => c.name === '大王');
    const hasSmallJoker = hand.some(c => c.name === '小王');
    const shouldGroupJokers = hasBigJoker && hasSmallJoker;
    if (!shouldGroupJokers) {
      return hand.sort((a, b) => a.strength - b.strength);
    }

    const quValueRank = (value: string) => {
      if (value === 'J') return 0;
      if (value === 'Q') return 1;
      if (value === 'K') return 2;
      return 9;
    };

    const buildKey = (c: Card): [number, number, number, string] => {
      if (c.name === '曲') {
        const colorRank = c.color === 'black' ? 0 : 1;
        return [0, colorRank, quValueRank(c.value), c.id];
      }
      if (c.name === '大王' || c.name === '小王') {
        const jokerRank = c.name === '大王' ? 0 : 1;
        return [1, jokerRank, 0, c.id];
      }
      return [2, c.strength, 0, c.id];
    };

    return hand.sort((a, b) => {
      const ka = buildKey(a);
      const kb = buildKey(b);
      if (ka[0] !== kb[0]) return ka[0] - kb[0];
      if (ka[1] !== kb[1]) return ka[1] - kb[1];
      if (ka[2] !== kb[2]) return ka[2] - kb[2];
      return ka[3].localeCompare(kb[3]);
    });
  }, [gameState.hands, myPlayerId]);

  const addLog = useCallback((msg: string) => {
    console.info('[Xuantuotuo]', msg); // 控制台镜像日志，便于调试多人联机
    setGameState(prev => ({ ...prev, logs: [msg, ...prev.logs].slice(0, 30) }));
  }, []);

  const parseRoomIdInput = useCallback((input: string): string => {
    const raw = input.trim();
    if (!raw) return '';
    try {
      const url = new URL(raw);
      const roomId = url.searchParams.get('room');
      if (roomId) return roomId.trim();
    } catch {
      // ignore
    }
    return raw;
  }, []);

  const closeAllConnections = useCallback(() => {
    Object.values(connectionsRef.current).forEach((c) => {
      const conn = c as any;
      try { conn.close(); } catch {}
    });
    connectionsRef.current = {};
    setConnectedPeers([]);
  }, []);

  const handlePeerDisconnected = useCallback((peerId: string) => {
    setConnectedPeers(prev => prev.filter(id => id !== peerId));

    if (isHostRef.current) {
      setSlots(prev => {
        let changed = false;
        const next = { ...prev };
        for (const seat of [PlayerId.AI_LEFT, PlayerId.AI_RIGHT]) {
          if (prev[seat]?.type === 'human' && prev[seat]?.peerId === peerId) {
            next[seat] = { type: 'empty', name: '等待加入...' };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    } else {
      if (peerId === hostPeerIdRef.current) {
        setGameState(INITIAL_GAME_STATE(gameStateRef.current.starCoins));
        setHostPeerId('');
        setMyPlayerId(PlayerId.PLAYER);
      }
    }

    addLog(`🔌 联机连接已断开：${peerId}`);
  }, [addLog]);

  const joinRoom = useCallback((rawRoomId?: string) => {
    const trimmedName = normalizedNickname;
    if (!trimmedName) {
      addLog('⚠️ 请输入你的昵称后再加入房间。');
      return;
    }
    const roomId = parseRoomIdInput(rawRoomId ?? targetId);
    if (!roomId) {
      addLog('⚠️ 请输入好友房号或邀请链接。');
      return;
    }
    if (!peerRef.current) {
      addLog('⏳ 联机初始化中，请稍后再试。');
      return;
    }
    if (!peerRef.current.id) {
      addLog('⏳ 联机 ID 尚未就绪，请稍后再试。');
      return;
    }
    if (roomId === peerRef.current.id) {
      addLog('⚠️ 不能加入自己的房间。');
      return;
    }

    SoundEngine.init();
    closeAllConnections();
    setIsHost(false);
    setMyPlayerId(PlayerId.PLAYER);
    setHostPeerId(roomId);
    // 这里直接关闭加入弹窗并切换到“备战/等待”界面。
    // 之前仅在收到房主返回的 ASSIGN_SEAT 后才关闭弹窗，
    // 导致用户点击“加入”后表面上“没反应”（弹窗遮挡了等待界面），
    // 实际房主端已经看到玩家加入。提早关闭可即时反馈。
    setShowJoinModal(false);
    setGameState(prev => ({ ...prev, phase: GamePhase.WAITING }));
    addLog(`🔗 正在加入房间：${roomId}`);

    const conn = peerRef.current.connect(roomId, { reliable: true, metadata: { nickname: trimmedName } });
    connectionsRef.current[roomId] = conn;

    conn.on('data', (data: NetworkMessage) => handleNetworkMessageRef.current(data, roomId));
    conn.on('open', () => {
      setConnectedPeers(prev => (prev.includes(roomId) ? prev : [...prev, roomId]));
      addLog('✅ 已连接房主，等待分配席位...');
    });
    conn.on('close', () => handlePeerDisconnected(roomId));
    conn.on('error', () => handlePeerDisconnected(roomId));
  }, [addLog, closeAllConnections, parseRoomIdInput, targetId, handlePeerDisconnected, normalizedNickname]);

  const getNextRespondents = useCallback((initiator: PlayerId) => {
    const order = [PlayerId.PLAYER, PlayerId.AI_RIGHT, PlayerId.AI_LEFT];
    const idx = order.indexOf(initiator);
    const sorted: PlayerId[] = [];
    for(let i = 1; i < 3; i++) {
        sorted.push(order[(idx + i) % 3]);
    }
    return sorted;
  }, []);

  const sendToPeer = useCallback((peerId: string, type: NetworkMessageType, payload: any) => {
    const conn = connectionsRef.current[peerId] as any;
    if (conn && conn.open) conn.send({ type, payload, senderId: peerRef.current?.id });
  }, []);

  const broadcast = useCallback((type: NetworkMessageType, payload: any) => {
    Object.values(connectionsRef.current).forEach((c) => {
      const conn = c as any;
      if (conn.open) conn.send({ type, payload, senderId: peerRef.current?.id });
    });
  }, []);

  useEffect(() => {
    if (!isHost) return;
    const publicSlots: Record<PlayerId, { type: SlotInfo['type']; name: string }> = {
      [PlayerId.PLAYER]: { type: slots[PlayerId.PLAYER].type, name: slots[PlayerId.PLAYER].name },
      [PlayerId.AI_LEFT]: { type: slots[PlayerId.AI_LEFT].type, name: slots[PlayerId.AI_LEFT].name },
      [PlayerId.AI_RIGHT]: { type: slots[PlayerId.AI_RIGHT].type, name: slots[PlayerId.AI_RIGHT].name },
    };
    broadcast('SYNC_SLOTS', publicSlots);
  }, [isHost, slots, broadcast]);

  const syncStateToPeer = useCallback((peerId: string, seat: PlayerId, state: GameState) => {
    sendToPeer(peerId, 'SYNC_STATE', buildSyncedStateForSeat(state, seat));
  }, [sendToPeer]);

  const syncStateToClients = useCallback((state: GameState) => {
    if (!isHostRef.current) return;
    const currentSlots = slotsRef.current;
    [PlayerId.AI_LEFT, PlayerId.AI_RIGHT].forEach(seat => {
      const slot = currentSlots[seat];
      if (slot?.type === 'human' && slot.peerId) {
        syncStateToPeer(slot.peerId, seat, state);
      }
    });
  }, [syncStateToPeer]);

  const sendToHost = useCallback((type: NetworkMessageType, payload: any) => {
    if (isHostRef.current) return;
    const hostId = hostPeerIdRef.current;
    const hostConn = hostId
      ? (connectionsRef.current[hostId] as any)
      : (Object.values(connectionsRef.current)[0] as any);
    if (hostConn && hostConn.open) hostConn.send({ type, payload, senderId: peerRef.current?.id });
  }, []);

  const findSeatByPeerId = useCallback((peerId: string, currentSlots: Record<PlayerId, SlotInfo>): PlayerId | null => {
    for (const seat of [PlayerId.AI_LEFT, PlayerId.AI_RIGHT]) {
      const slot = currentSlots[seat];
      if (slot?.type === 'human' && slot.peerId === peerId) return seat;
    }
    return null;
  }, []);

  const handleHostAcceptConnection = useCallback((peerId: string, nickname?: string) => {
    if (!isHostRef.current) return;

    const buildNickname = (seat: PlayerId) => {
      const fallback = seat === PlayerId.AI_LEFT ? '左位侠客' : '右位侠客';
      if (typeof nickname !== 'string') return fallback;
      const trimmed = nickname.trim();
      if (!trimmed) return fallback;
      return trimmed.slice(0, 12);
    };

    const currentSlots = slotsRef.current;
    const existingSeat = findSeatByPeerId(peerId, currentSlots);
    if (existingSeat) {
      if (nickname?.trim()) {
        const finalName = nickname.trim().slice(0, 12);
        setSlots(prev => ({
          ...prev,
          [existingSeat]: { ...prev[existingSeat], name: finalName, peerId },
        }));
      }
      sendToPeer(peerId, 'ASSIGN_SEAT', { playerId: existingSeat });
      syncStateToPeer(peerId, existingSeat, gameStateRef.current);
      return;
    }

    const availableSeat = [PlayerId.AI_LEFT, PlayerId.AI_RIGHT].find(seat => currentSlots[seat]?.type === 'empty') || null;
    if (!availableSeat) {
      sendToPeer(peerId, 'ERROR', { message: '房间已满：没有空位可加入。' });
      const conn = connectionsRef.current[peerId] as any;
      if (conn && typeof conn.close === 'function') conn.close();
      return;
    }

    const resolvedName = buildNickname(availableSeat);
    setSlots(prev => ({
      ...prev,
      [availableSeat]: { type: 'human', name: resolvedName, peerId },
    }));

    sendToPeer(peerId, 'ASSIGN_SEAT', { playerId: availableSeat });
    syncStateToPeer(peerId, availableSeat, gameStateRef.current);
  }, [findSeatByPeerId, sendToPeer, syncStateToPeer]);

  // 初始化 PeerJS
  useEffect(() => {
    if (typeof Peer === 'undefined') return;
    
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam) {
      setTargetId(roomParam);
      autoJoinRoomRef.current = roomParam;
    }

    const env = (import.meta as any).env || {};
    const peerOptions: any = {};
    if (env.VITE_PEER_HOST) peerOptions.host = env.VITE_PEER_HOST;
    if (env.VITE_PEER_PORT && !Number.isNaN(Number(env.VITE_PEER_PORT))) peerOptions.port = Number(env.VITE_PEER_PORT);
    if (env.VITE_PEER_PATH) peerOptions.path = env.VITE_PEER_PATH;
    if (typeof env.VITE_PEER_SECURE !== 'undefined') {
      peerOptions.secure = String(env.VITE_PEER_SECURE) === 'true';
    } else {
      peerOptions.secure = window.location.protocol === 'https:';
    }

    let destroyed = false;

    const cleanupPeer = () => {
      if (peerRef.current) {
        try { peerRef.current.destroy(); } catch {}
        peerRef.current = null;
      }
    };

    const setupPeer = () => {
      if (destroyed) return;
      const roomCode = generateRoomCode();
      const peer = new Peer(roomCode, peerOptions);
      peerRef.current = peer;

      peer.on('open', (id: string) => {
        setMyId(id);
        addLog(`🌐 你的联机 ID 已就绪: ${id}`);
        const autoRoomId = autoJoinRoomRef.current;
        if (autoRoomId) {
          autoJoinRoomRef.current = '';
          setTimeout(() => {
            if (!isHostRef.current) joinRoom(autoRoomId);
          }, 50);
        }
      });

      peer.on('error', (err: any) => {
        console.warn('PeerJS error:', err);
        if (!destroyed && err?.type === 'unavailable-id') {
          addLog('⚠️ 房间号被占用，正在换一个...');
          cleanupPeer();
          setTimeout(() => setupPeer(), 100);
          return;
        }
        addLog(`❌ 联机错误：${err?.type || err?.message || String(err)}`);
      });

      peer.on('connection', (conn: any) => {
        if (!isHostRef.current) {
          try { conn.close(); } catch {}
          return;
        }
        connectionsRef.current[conn.peer] = conn;
        conn.on('data', (data: NetworkMessage) => handleNetworkMessageRef.current(data, conn.peer));
        conn.on('open', () => {
          setConnectedPeers(prev => (prev.includes(conn.peer) ? prev : [...prev, conn.peer]));
          handleHostAcceptConnection(conn.peer, conn.metadata?.nickname);
        });
        conn.on('close', () => handlePeerDisconnected(conn.peer));
        conn.on('error', () => handlePeerDisconnected(conn.peer));
      });
    };

    setupPeer();

    return () => {
      destroyed = true;
      cleanupPeer();
    };
  }, []);

  const settlementData = useMemo(() => {
    const players = [PlayerId.PLAYER, PlayerId.AI_LEFT, PlayerId.AI_RIGHT];
    const stats = players.map(pid => {
      const count = gameState.collected[pid].length;
      return { id: pid, cards: count, ...getRewardInfo(count) };
    });
    const winners = stats.filter(s => s.coins > 0);
    const losers = stats.filter(s => s.coins === 0);
    const results = stats.map(s => ({ ...s, netGain: 0, multiplier: 0, finalMultiplier: 1 }));

    results.forEach(res => {
      const currentStat = stats.find(s => s.id === res.id)!;
      const personalMultiplier = gameState.multipliers[res.id];
      res.finalMultiplier = personalMultiplier * gameState.grabMultiplier;

      if (currentStat.coins > 0) {
        res.netGain = currentStat.coins * res.finalMultiplier * losers.length;
      } else {
        const totalWin = winners.reduce((sum, w) => sum + (w.coins * (gameState.multipliers[w.id] || 1) * gameState.grabMultiplier), 0);
        res.netGain = -totalWin;
      }
    });

    // “扣了/宣”额外结算：
    // 若有人在某次扣了后选择“宣”，则等同于承诺把自己的档位升到下一档；
    // 若最终没达到目标档位，且当次扣了发起者(A)最终赢(>=9)，则宣的人需按A倍率赔付星光币给A。
    gameState.kouLeHistory.forEach(evt => {
      const initiatorStat = stats.find(s => s.id === evt.initiator);
      const initiatorRes = results.find(r => r.id === evt.initiator);
      const challengerStat = stats.find(s => s.id === evt.challenger);
      const challengerRes = results.find(r => r.id === evt.challenger);
      if (!initiatorStat || !initiatorRes || !challengerStat || !challengerRes) return;
      if (initiatorStat.coins <= 0) return; // A 不够则不触发额外赔付

      const reachedTarget = challengerStat.cards >= evt.targetCollected;
      if (reachedTarget) return;

      const riskAmount = (initiatorStat.coins * initiatorRes.finalMultiplier) * 2;
      challengerRes.netGain -= riskAmount;
      initiatorRes.netGain += riskAmount;
    });
    return results;
  }, [gameState.collected, gameState.kouLeHistory, gameState.aiNames, gameState.multipliers, gameState.grabMultiplier]);

  // 更新星光币并在结算时播放声音
  useEffect(() => {
    if (gameState.phase === GamePhase.SETTLEMENT) {
      if (isHost && !updatedCoinsForRound.current) {
        setGameState(prev => {
          const newCoins = { ...prev.starCoins };
          settlementData.forEach(res => {
            newCoins[res.id as PlayerId] += res.netGain;
          });
          const newState = { ...prev, starCoins: newCoins };
          syncStateToClients(newState);
          return newState;
        });
        updatedCoinsForRound.current = true;
      }

      const myRes = settlementData.find(r => r.id === myPlayerId);
      if (myRes) {
        if (myRes.netGain > 0) SoundEngine.play('victory');
        else if (myRes.netGain < 0) SoundEngine.play('defeat');
        else SoundEngine.play('settle');
      }
    } else {
      updatedCoinsForRound.current = false;
    }
  }, [gameState.phase, settlementData, isHost, syncStateToClients, myPlayerId]);

  const initGame = useCallback((preservedStarter?: PlayerId) => {
    if (!isHost) return;
    setGameState(prev => {
      const s = { ...prev, phase: GamePhase.DEALING };
      syncStateToClients(s);
      return s;
    });
    SoundEngine.play('shuffle');
    setTimeout(() => {
      const deck = createDeck().sort(() => Math.random() - 0.5);
      const hands = {
        [PlayerId.PLAYER]: deck.slice(0, 8),
        [PlayerId.AI_LEFT]: deck.slice(8, 16),
        [PlayerId.AI_RIGHT]: deck.slice(16, 24),
      };
      if (Object.values(hands).some(h => checkNoXiang(h))) {
        addLog("🔔 系统: 有人手牌‘无相’，重新洗牌...");
        initGame(preservedStarter);
        return;
      }
      const starter = preservedStarter || [PlayerId.PLAYER, PlayerId.AI_LEFT, PlayerId.AI_RIGHT][Math.floor(Math.random() * 3)];
      setGameState(prev => {
        const newState: GameState = {
          ...prev, phase: GamePhase.BETTING, hands,
          collected: { [PlayerId.PLAYER]: [], [PlayerId.AI_LEFT]: [], [PlayerId.AI_RIGHT]: [] },
          table: [], turn: starter, starter: starter, roundHistory: [],
          kouLeInitiator: null, 
          challengers: { [PlayerId.PLAYER]: 0, [PlayerId.AI_LEFT]: 0, [PlayerId.AI_RIGHT]: 0 },
          kouLeHistory: [],
          kouLeUsedThisTrick: false,
          kouLeResponses: { [PlayerId.PLAYER]: null, [PlayerId.AI_LEFT]: null, [PlayerId.AI_RIGHT]: null },
          multipliers: { [PlayerId.PLAYER]: 1, [PlayerId.AI_LEFT]: 1, [PlayerId.AI_RIGHT]: 1 },
          grabber: null, grabMultiplier: 1, betTurn: starter,
          betResponses: { [PlayerId.PLAYER]: false, [PlayerId.AI_LEFT]: false, [PlayerId.AI_RIGHT]: false },
          logs: [`🎴 发牌完成！进入博弈阶段，由 ${getPlayerName(starter)} 先手决策。`, ...prev.logs].slice(0, 30),
          nextStarter: null
        };
        syncStateToClients(newState);
        return newState;
      });
      SoundEngine.play('deal');
      }, 2000);
  }, [isHost, syncStateToClients, addLog, getPlayerName]);

  const resolveTrick = useCallback((currentTable: Play[], currentHands: Record<PlayerId, Card[]>) => {
    setGameState(prev => {
      // 安全检查1：确保传入的table有且只有3个Play
      if (currentTable.length !== 3) {
        console.warn(`resolveTrick called with ${currentTable.length} plays instead of 3`);
        return prev;
      }

      // 安全检查2：确保当前状态的table也是3，避免重复执行
      // 如果table已经被清空（上一次resolveTrick执行过了），则跳过
      if (prev.table.length !== 3) {
        console.warn(`resolveTrick skipped: prev.table.length is ${prev.table.length}, already processed`);
        return prev;
      }

      const sortedPlays = [...currentTable].sort((a, b) => b.strength - a.strength);
      const winner = sortedPlays[0].playerId;
      const allTrickCards = currentTable.flatMap(p => p.cards);

      const newCollected = { ...prev.collected };
      newCollected[winner] = [...newCollected[winner], ...allTrickCards];

      const newLogs = [...prev.logs];
      newLogs.unshift(`✅ ${getPlayerName(winner)} 赢得了本轮，收走 ${allTrickCards.length} 张牌。`);

      const roundHistory = [...prev.roundHistory, currentTable];
      
      let nextPhase = prev.phase;
      let nextTurn = winner;
      let nextStarter = winner;

      if (Object.values(currentHands).every((h: any) => h.length === 0)) {
        nextPhase = GamePhase.SETTLEMENT;
        const newState = { ...prev, collected: newCollected, logs: newLogs.slice(0, 30), phase: nextPhase, roundHistory, turn: nextTurn, starter: nextStarter, table: [], kouLeUsedThisTrick: false };
        if (isHost) syncStateToClients(newState);
        return newState;
      }
      
      const newState = { ...prev, collected: newCollected, logs: newLogs.slice(0, 30), roundHistory, turn: nextTurn, starter: nextStarter, table: [], kouLeUsedThisTrick: false };
      if (isHost) syncStateToClients(newState);
      return newState;
    });
    SoundEngine.play('win');
  }, [isHost, syncStateToClients, getPlayerName]);

  const processPlayCards = useCallback((pid: PlayerId, cards: Card[], isDiscard: boolean) => {
    setGameState(prev => {
      if (prev.turn !== pid || prev.phase !== GamePhase.PLAYING) return prev;

      // 安全校验：只允许出自己手里的牌（按 id 校验）
      const handIds = new Set(prev.hands[pid].map(c => c.id));
      const seen = new Set<string>();
      for (const c of cards) {
        if (!c || typeof c.id !== 'string') return prev;
        if (seen.has(c.id)) return prev;
        seen.add(c.id);
        if (!handIds.has(c.id)) return prev;
      }

      const targetPlay = prev.table.length > 0 ? prev.table[0] : null;
      const currentMaxStr = prev.table.reduce((max, p) => Math.max(max, p.strength), -1);
      if (isDiscard) {
        // 首家不允许扣牌；且扣牌必须与首家出牌数量一致
        if (!targetPlay) return prev;
        if (cards.length !== targetPlay.cards.length) return prev;

        // 若存在可压过的有效出牌，则不允许扣牌（防止恶意“故意扣牌”）
        const validPlays = getValidPlays(prev.hands[pid], targetPlay, currentMaxStr);
        if (validPlays.length > 0) return prev;
      } else {
        const playRes = calculatePlayStrength(cards);
        // 首家必须出有效牌型
        if (!targetPlay && playRes.type === 'discard') return prev;
        // 非首家必须同类型、同张数，且严格压过当前最大牌
        if (targetPlay) {
          if (playRes.type !== targetPlay.type) return prev;
          if (cards.length !== targetPlay.cards.length) return prev;
          if (playRes.strength <= currentMaxStr) return prev;
        }
      }

      const pName = pid === PlayerId.PLAYER ? '您' : getPlayerName(pid);
      const playRes = calculatePlayStrength(cards);
      const strength = isDiscard ? -1 : playRes.strength;
      const type = isDiscard ? 'discard' : playRes.type;

      const newPlay: Play = { playerId: pid, cards, type, strength };
      const newHand = prev.hands[pid].filter(c => !cards.some(sc => sc.id === c.id));
      const newHands = { ...prev.hands, [pid]: newHand };
      const newTable = [...prev.table, newPlay];

      const isTrickOver = newTable.length === 3;
      let nextTurn = prev.turn;
      if (!isTrickOver) {
        const order = [PlayerId.PLAYER, PlayerId.AI_RIGHT, PlayerId.AI_LEFT];
        const curIdx = order.indexOf(pid);
        nextTurn = order[(curIdx + 1) % 3];
      }

      let logs = [...prev.logs];
      logs.unshift(`${pName} ${isDiscard ? '扣了' : '出了'} ${cards.length} 张牌。`);

      // 只在table刚好从2变成3时触发，避免重复调用
      if (prev.table.length === 2 && isTrickOver) {
        setTimeout(() => resolveTrick(newTable, newHands), 1200);
      }

      const nextS = { ...prev, hands: newHands, table: newTable, turn: nextTurn, logs: logs.slice(0, 30) };
      if (isHost) syncStateToClients(nextS);
      return nextS;
    });
    SoundEngine.play('play');
    setSelectedCards([]);
  }, [isHost, syncStateToClients, resolveTrick, getPlayerName]);

  const processInitiateKouLe = useCallback((pid: PlayerId) => {
    setGameState(prev => {
      if (prev.phase !== GamePhase.PLAYING) return prev;
      if (prev.table.length !== 0) return prev;
      if (prev.turn !== pid) return prev;
      if (prev.kouLeInitiator !== null) return prev; // 避免重复发起
      if (prev.kouLeUsedThisTrick) return prev; // 同一墩只允许发起一次“扣了”

      const newState = { 
        ...prev, 
        phase: GamePhase.KOU_LE_DECISION, 
        kouLeInitiator: pid, 
        kouLeUsedThisTrick: true,
        kouLeResponses: { [PlayerId.PLAYER]: null, [PlayerId.AI_LEFT]: null, [PlayerId.AI_RIGHT]: null },
        logs: [`📣 ${pid === PlayerId.PLAYER ? '您' : getPlayerName(pid)} 发起了“扣了”博弈！`, ...prev.logs].slice(0, 30)
      };
      if (isHost) syncStateToClients(newState);
      return newState;
    });
  }, [isHost, syncStateToClients, getPlayerName]);

  const processKouLeResponse = useCallback((pid: PlayerId, response: 'agree' | 'challenge') => {
    setGameState(prev => {
      if (prev.phase !== GamePhase.KOU_LE_DECISION) return prev;
      const initiator = prev.kouLeInitiator;
      if (!initiator) return prev;

      const respondents = getNextRespondents(initiator);
      const currentDecider = respondents.find(id => prev.kouLeResponses[id] === null);
      if (currentDecider !== pid) return prev;
      if (prev.kouLeResponses[pid] !== null) return prev;

      const newResponses = { ...prev.kouLeResponses, [pid]: response };
      const newChallengers = { ...prev.challengers };

      const pName = pid === PlayerId.PLAYER ? '您' : getPlayerName(pid);
      const logs = [`${pName} 选择了 ${response === 'agree' ? '同意(扣了)' : '宣(挑战)'}`, ...prev.logs];

      if (response === 'challenge') {
        newChallengers[pid] = (newChallengers[pid] || 0) + 1;

        const challengerCollectedAtChallenge = (prev.collected[pid] as Card[]).length;
        const { targetCollected, targetLevel } = getKouLeChallengeTarget(challengerCollectedAtChallenge);
        const newHistory = [
          ...prev.kouLeHistory,
          { initiator, challenger: pid, challengerCollectedAtChallenge, targetCollected }
        ];

        logs.unshift(`🎯 ${pName} 宣：目标【${targetLevel}】(需收牌≥${targetCollected}张)`);
        logs.unshift('⚔️ 有人选择“宣”，博弈达成，游戏继续！');

        const nextS = { 
          ...prev, 
          kouLeInitiator: null,
          kouLeResponses: { [PlayerId.PLAYER]: null, [PlayerId.AI_LEFT]: null, [PlayerId.AI_RIGHT]: null },
          challengers: newChallengers,
          kouLeHistory: newHistory,
          logs: logs.slice(0, 30), 
          phase: GamePhase.PLAYING 
        };
        if (isHost) syncStateToClients(nextS);
        return nextS;
      }

      const isLastRespondent = respondents[respondents.length - 1] === pid;
      if (isLastRespondent) {
        const allAgreed = respondents.every(id => newResponses[id] === 'agree');
        if (allAgreed) {
          const anyWinner = Object.values(prev.collected).some((cards: any) => cards.length >= 9);
          if (anyWinner) {
            logs.unshift('🔄 全员同意“扣了”，已有玩家达标，直接进入结算。');
            const nextS = { 
              ...prev, 
              kouLeInitiator: null,
              kouLeResponses: { [PlayerId.PLAYER]: null, [PlayerId.AI_LEFT]: null, [PlayerId.AI_RIGHT]: null },
              logs: logs.slice(0, 30), 
              phase: GamePhase.SETTLEMENT 
            };
            if (isHost) syncStateToClients(nextS);
            return nextS;
          } else {
            logs.unshift('🔄 全员同意“扣了”，且无人达标，重新发牌。');
            setTimeout(() => initGame(prev.starter), 1500);
            const nextS = { 
              ...prev, 
              kouLeInitiator: null,
              kouLeResponses: { [PlayerId.PLAYER]: null, [PlayerId.AI_LEFT]: null, [PlayerId.AI_RIGHT]: null },
              logs: logs.slice(0, 30), 
              phase: GamePhase.DEALING 
            };
            if (isHost) syncStateToClients(nextS);
            return nextS;
          }
        }
      }

      const nextS = { ...prev, kouLeResponses: newResponses, challengers: newChallengers, logs: logs.slice(0, 30) };
      if (isHost) syncStateToClients(nextS);
      return nextS;
    });
  }, [isHost, syncStateToClients, getNextRespondents, initGame, getPlayerName]);

  const processBet = useCallback((pid: PlayerId, multiplier: number, grab: boolean) => {
    setGameState(prev => {
      if (prev.phase !== GamePhase.BETTING) return prev;
      if (prev.betTurn !== pid) return prev;
      if (prev.betResponses[pid]) return prev;
      if (![1, 2, 4].includes(multiplier)) return prev;

      const newMults = { ...prev.multipliers, [pid]: multiplier };
      const newBetRes = { ...prev.betResponses, [pid]: true };
      let newGrabber = prev.grabber;
      let newGrabMultiplier = prev.grabMultiplier;
      let newStarter = prev.starter;

      const pName = pid === PlayerId.PLAYER ? '您' : getPlayerName(pid);
      const logs = [...prev.logs];

      if (grab) {
        if (newGrabber !== null) {
          newGrabMultiplier *= 2;
          logs.unshift(`🔥 ${pName} 顶抢收牌！全局倍率升级为 x${newGrabMultiplier}！`);
        } else {
          newGrabMultiplier = 2;
          logs.unshift(`🎴 ${pName} 发起了抢收牌！全局收益翻倍！`);
        }
        newGrabber = pid;
        newStarter = pid; 
        SoundEngine.play('grab');
      } else {
        logs.unshift(`${pName} 选择了${multiplier > 1 ? (multiplier === 4 ? '超级加倍' : '加倍') : '不加倍'}`);
      }

      const order = [PlayerId.PLAYER, PlayerId.AI_RIGHT, PlayerId.AI_LEFT];
      const curIdx = order.indexOf(pid);
      const nextPid = order[(curIdx + 1) % 3];
      
      let nextPhase = GamePhase.BETTING;
      let finalBetTurn: PlayerId | null = nextPid;

      if (Object.values(newBetRes).every(v => v)) {
        nextPhase = GamePhase.PLAYING;
        finalBetTurn = null;
        logs.unshift(`🔥 博弈结束，对局开始！由 ${getPlayerName(newStarter)} 先出牌。`);
      }

      const nextS = { ...prev, multipliers: newMults, betResponses: newBetRes, grabber: newGrabber, grabMultiplier: newGrabMultiplier, starter: newStarter, turn: newStarter, logs: logs.slice(0, 30), phase: nextPhase, betTurn: finalBetTurn };
      if (isHost) syncStateToClients(nextS);
      return nextS;
    });
    SoundEngine.play('bet');
  }, [isHost, syncStateToClients, getPlayerName]);

  const handleNetworkMessage = useCallback((msg: NetworkMessage, remotePeerId?: string) => {
    const isAuthorizedRemoteForSeat = (pid: PlayerId): boolean => {
      if (!remotePeerId) return false;
      if (pid === PlayerId.PLAYER) return false; // 房主席位仅允许本地操作
      const slot = slotsRef.current[pid];
      return slot?.type === 'human' && slot.peerId === remotePeerId;
    };

    switch (msg.type) {
      case 'SYNC_STATE': {
        if (isHostRef.current) break;
        setGameState(msg.payload);
        break;
      }
      case 'SYNC_SLOTS': {
        if (isHostRef.current) break;
        const payload = msg.payload as Record<PlayerId, { type: SlotInfo['type']; name: string }> | undefined;
        if (!payload) break;
        setSlots(prev => ({
          [PlayerId.PLAYER]: { ...prev[PlayerId.PLAYER], type: payload[PlayerId.PLAYER].type, name: payload[PlayerId.PLAYER].name },
          [PlayerId.AI_LEFT]: { ...prev[PlayerId.AI_LEFT], type: payload[PlayerId.AI_LEFT].type, name: payload[PlayerId.AI_LEFT].name },
          [PlayerId.AI_RIGHT]: { ...prev[PlayerId.AI_RIGHT], type: payload[PlayerId.AI_RIGHT].type, name: payload[PlayerId.AI_RIGHT].name },
        }));
        break;
      }
      case 'ASSIGN_SEAT': {
        if (isHostRef.current) break;
        const pid = msg.payload?.playerId as PlayerId | undefined;
        if (!pid) break;
        setMyPlayerId(pid);
        setShowJoinModal(false);
        addLog(`✅ 已加入房间，席位分配：${pid === PlayerId.AI_LEFT ? '左家' : (pid === PlayerId.AI_RIGHT ? '右家' : '房主')}`);
        break;
      }
      case 'ERROR': {
        addLog(`❌ ${msg.payload?.message || msg.payload || '发生未知错误'}`);
        break;
      }
      case 'ACTION_PLAY': {
        if (!isHostRef.current) break;
        const pid = msg.payload?.playerId as PlayerId | undefined;
        if (!pid || !isAuthorizedRemoteForSeat(pid)) break;
        processPlayCards(pid, msg.payload.cards, msg.payload.isDiscard);
        break;
      }
      case 'ACTION_KOU_LE_INIT': {
        if (!isHostRef.current) break;
        const pid = msg.payload?.playerId as PlayerId | undefined;
        if (!pid || !isAuthorizedRemoteForSeat(pid)) break;
        processInitiateKouLe(pid);
        break;
      }
      case 'ACTION_KOU_LE_RES': {
        if (!isHostRef.current) break;
        const pid = msg.payload?.playerId as PlayerId | undefined;
        if (!pid || !isAuthorizedRemoteForSeat(pid)) break;
        processKouLeResponse(pid, msg.payload.response);
        break;
      }
      case 'ACTION_BET': {
        if (!isHostRef.current) break;
        const pid = msg.payload?.playerId as PlayerId | undefined;
        if (!pid || !isAuthorizedRemoteForSeat(pid)) break;
        processBet(pid, msg.payload.multiplier, msg.payload.grab);
        break;
      }
    }
  }, [addLog, processBet, processPlayCards, processInitiateKouLe, processKouLeResponse]);

  useEffect(() => {
    handleNetworkMessageRef.current = handleNetworkMessage;
  }, [handleNetworkMessage]);

  // AI 逻辑控制: 加倍博弈阶段
  useEffect(() => {
    if (isHost && gameState.phase === GamePhase.BETTING && gameState.betTurn && slots[gameState.betTurn!].type === 'ai') {
      const timer = setTimeout(() => {
        const decision = aiDecideBet(gameState.hands[gameState.betTurn!], gameState.grabMultiplier, gameState.grabber);
        processBet(gameState.betTurn!, decision.multiplier, decision.grab);
      }, 1500 + Math.random() * 1000);
      return () => clearTimeout(timer);
    }
  }, [isHost, gameState.phase, gameState.betTurn, gameState.hands, gameState.grabMultiplier, gameState.grabber, slots, processBet]);

  // AI 逻辑控制: 出牌阶段
  useEffect(() => {
    if (isHost && gameState.phase === GamePhase.PLAYING && slots[gameState.turn].type === 'ai' && gameState.table.length < 3) {
      const timer = setTimeout(() => {
        const hand = gameState.hands[gameState.turn];
        const targetPlay = gameState.table.length > 0 ? gameState.table[0] : null;
        const currentMaxStr = gameState.table.reduce((max, p) => Math.max(max, p.strength), -1);
        const collectedCount = (gameState.collected[gameState.turn] as Card[]).length;
        
        const cardsToPlay = aiDecidePlay(hand, targetPlay, currentMaxStr, collectedCount);
        const isDiscard = targetPlay && calculatePlayStrength(cardsToPlay).strength <= currentMaxStr;
        processPlayCards(gameState.turn, cardsToPlay, !!isDiscard);
      }, 1500 + Math.random() * 1000);
      return () => clearTimeout(timer);
    }
  }, [isHost, gameState.phase, gameState.turn, gameState.hands, gameState.table, gameState.collected, slots, processPlayCards]);

  // AI 逻辑控制: “扣了”博弈响应阶段
  useEffect(() => {
    if (isHost && gameState.phase === GamePhase.KOU_LE_DECISION) {
      const initiator = gameState.kouLeInitiator;
      if (!initiator) return;

      const respondents = getNextRespondents(initiator);
      const currentDecider = respondents.find(id => gameState.kouLeResponses[id] === null);

      if (currentDecider && slots[currentDecider].type === 'ai') {
        const timer = setTimeout(() => {
          const decision = aiEvaluateKouLe(gameState.hands[currentDecider], (gameState.collected[currentDecider] as Card[]).length);
          processKouLeResponse(currentDecider, decision);
        }, 1500 + Math.random() * 1000);
        return () => clearTimeout(timer);
      }
    }
  }, [isHost, gameState.phase, gameState.kouLeInitiator, gameState.kouLeResponses, gameState.hands, gameState.collected, slots, processKouLeResponse, getNextRespondents]);

  const quitToLobby = useCallback(() => {
    closeAllConnections();
    setGameState(INITIAL_GAME_STATE(gameStateRef.current.starCoins));
    setIsHost(false);
    setHostPeerId('');
    setMyPlayerId(PlayerId.PLAYER);
    setSlots({
      [PlayerId.PLAYER]: { type: 'human', name: '房主' },
      [PlayerId.AI_LEFT]: { type: 'empty', name: '等待加入...' },
      [PlayerId.AI_RIGHT]: { type: 'empty', name: '等待加入...' },
    });
    setMyId(peerRef.current?.id || '');
  }, [closeAllConnections]);

  const handleShareRoom = useCallback(() => {
    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${myId}`;
    navigator.clipboard.writeText(shareUrl);
    addLog("📋 邀请链接已复制！发给好友即可加入。");
  }, [myId, addLog]);

  const handleAction = useCallback((isDiscard: boolean) => {
    if (gameState.turn !== myPlayerId) return;
    if (isHost) {
      processPlayCards(myPlayerId, selectedCards, isDiscard);
    } else {
      sendToHost('ACTION_PLAY', { playerId: myPlayerId, cards: selectedCards, isDiscard });
      setSelectedCards([]);
    }
  }, [gameState.turn, isHost, myPlayerId, processPlayCards, selectedCards, sendToHost]);

  const handleHint = useCallback(() => {
    const targetPlay = gameState.table.length > 0 ? gameState.table[0] : null;
    const currentMaxStr = gameState.table.reduce((max, p) => Math.max(max, p.strength), -1);
    const valid = getValidPlays(gameState.hands[myPlayerId], targetPlay, currentMaxStr);
    if (valid.length > 0) {
      setSelectedCards(valid[0]);
    } else {
      addLog("💡 提示：您没有比场上更大的牌了，请选择牌进行扣牌。");
    }
  }, [addLog, gameState.hands, gameState.table, myPlayerId]);

  const handleBetDecision = useCallback((multiplier: number, grab: boolean) => {
    if (gameState.phase !== GamePhase.BETTING) return;
    if (gameState.betTurn !== myPlayerId) return;
    if (isHost) {
      processBet(myPlayerId, multiplier, grab);
    } else {
      sendToHost('ACTION_BET', { playerId: myPlayerId, multiplier, grab });
    }
  }, [gameState.phase, gameState.betTurn, isHost, myPlayerId, processBet, sendToHost]);

  const handleInitiateKouLeAction = useCallback(() => {
    if (isHost) {
      processInitiateKouLe(myPlayerId);
    } else {
      sendToHost('ACTION_KOU_LE_INIT', { playerId: myPlayerId });
    }
  }, [isHost, myPlayerId, processInitiateKouLe, sendToHost]);

  const handleKouLeResponseAction = useCallback((response: 'agree' | 'challenge') => {
    if (gameState.phase !== GamePhase.KOU_LE_DECISION) return;
    if (isHost) {
      processKouLeResponse(myPlayerId, response);
    } else {
      sendToHost('ACTION_KOU_LE_RES', { playerId: myPlayerId, response });
    }
  }, [gameState.phase, isHost, myPlayerId, processKouLeResponse, sendToHost]);

  const renderLobby = () => (
    <div className="absolute inset-0 z-[500] bg-slate-950 flex flex-col items-center justify-start landscape:justify-center p-6 landscape:p-3 landscape:py-2 pt-14 md:pt-24 landscape:pt-6 bg-[url('https://www.transparenttextures.com/patterns/dark-matter.png')] overflow-y-auto custom-scrollbar">
      <div className="text-center mt-6 mb-10 landscape:mt-2 landscape:mb-3 animate-in fade-in slide-in-from-top-10 duration-1000">
        <h1 className="text-7xl landscape:text-4xl font-black chinese-font text-emerald-500 drop-shadow-[0_0_15px_rgba(16,185,129,0.5)] mb-2 landscape:mb-1 leading-tight py-4 landscape:py-1">宣 坨 坨</h1>
        <p className="text-slate-300 uppercase tracking-[0.3em] text-base landscape:text-sm font-bold">Traditional Shanxi Strategy Game</p>
      </div>

      <div className="w-full max-w-6xl flex flex-col gap-6 items-center md:flex-row md:items-start md:justify-center md:gap-10">
        <div className="order-2 md:order-1 w-full max-w-xs md:max-w-none md:basis-[14rem] md:flex-none flex justify-center md:justify-end">
          <div className="w-full md:w-[14rem] bg-slate-950/60 border border-white/10 rounded-[1.75rem] p-5 landscape:p-4 flex flex-col gap-4 shadow-[0_20px_45px_-30px_rgba(14,165,233,0.35)]">
            <div className="flex items-center gap-2 text-sm uppercase tracking-[0.35em] font-black text-slate-300">
              <span className="text-emerald-400 text-lg">⇄</span>
              加入房间
            </div>
            <p className="text-sm landscape:text-xs text-slate-400 leading-relaxed">需先设置江湖名，再通过按钮输入房号或邀请链接加入。</p>
            <button onClick={() => setShowJoinModal(true)} disabled={!isNicknameReady} className="w-full bg-gradient-to-r from-cyan-500/80 to-emerald-500/80 text-slate-900 font-black chinese-font text-sm rounded-2xl py-2.5 transition-all hover:from-cyan-400/90 hover:to-emerald-400/90 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100">输入房号加入</button>
            <p className="text-xs landscape:text-[11px] text-slate-400">昵称填写后才能加入牌局。</p>
          </div>
        </div>

        <div className="order-1 md:order-2 flex justify-center w-full max-w-md">
          <div className="flex flex-col gap-5 landscape:gap-2 w-full animate-in fade-in slide-in-from-bottom-10 duration-1000 delay-300">
            <div className="flex flex-col gap-2 bg-slate-900/40 border border-white/5 rounded-3xl landscape:rounded-2xl p-4 shadow-[0_25px_60px_-40px_rgba(15,118,110,0.7)]">
              <label className="text-sm landscape:text-[11px] text-slate-200 font-black tracking-[0.45em] uppercase flex items-center gap-1">江湖名<span className="text-red-500 text-base" aria-hidden="true">*</span></label>
              <input value={myNickname} onChange={e => setMyNickname(e.target.value.slice(0, 12))} placeholder="请输入让人记得住的外号..." required aria-required="true" aria-invalid={!isNicknameReady} className="bg-slate-950 border border-white/10 rounded-2xl landscape:rounded-xl px-4 py-3 chinese-font font-bold text-emerald-400 placeholder:text-slate-700 focus:border-emerald-500/50 focus:outline-none transition-all" />
              <p className="text-xs landscape:text-[11px] text-slate-400">所有玩家都会在房内看到该昵称。</p>
            </div>
            <button onClick={() => { 
              const trimmed = normalizedNickname;
              if (!trimmed) { addLog('⚠️ 请输入你的昵称后再开设牌局。'); return; }
              SoundEngine.init(); 
              closeAllConnections(); 
              setSlots({
                [PlayerId.PLAYER]: { type: 'human', name: trimmed },
                [PlayerId.AI_LEFT]: { type: 'empty', name: '等待加入...' },
                [PlayerId.AI_RIGHT]: { type: 'empty', name: '等待加入...' },
              });
              setHostPeerId(''); 
              setMyPlayerId(PlayerId.PLAYER); 
              setIsHost(true); 
              setGameState(prev => ({...prev, phase: GamePhase.WAITING}));
            }} disabled={!isNicknameReady} className="group relative overflow-hidden py-6 landscape:py-3 rounded-3xl landscape:rounded-2xl bg-emerald-600 font-black text-2xl landscape:text-lg chinese-font shadow-[0_10px_40px_-10px_rgba(16,185,129,0.5)] active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none disabled:active:scale-100">
              <span className="relative z-10">开 设 牌 局</span>
              <div className="absolute inset-0 bg-gradient-to-tr from-emerald-400/20 to-transparent opacity-0 group-active:opacity-100 transition-opacity"></div>
            </button>
            <button onClick={() => setShowRules(true)} className="py-4 landscape:py-2 text-slate-200 font-black transition-all uppercase tracking-widest text-sm landscape:text-xs">查看游戏规则</button>
          </div>
        </div>

        <div className="order-3 w-full max-w-xs md:max-w-none md:basis-[14rem] md:flex-none flex justify-center md:justify-start">
          <div className="w-full md:w-[14rem] bg-slate-950/60 border border-white/10 rounded-[1.75rem] p-5 landscape:p-4 flex flex-col gap-3 shadow-[0_20px_45px_-30px_rgba(16,185,129,0.5)]">
            <div className="flex items-center justify-between text-sm uppercase tracking-[0.35em] font-black text-slate-200">
              <span>我的房号</span>
              <span className="text-slate-400">{myId ? '可分享' : '待生成'}</span>
            </div>
            <div className="text-emerald-400 font-mono font-black text-4xl text-center py-1">{myId || '——'}</div>
            <p className="text-sm landscape:text-xs text-slate-400">{myId ? '复制房号或分享链接，好友即可从左侧加入。' : '完成昵称并开设牌局后将生成房号。'}</p>
            <button onClick={handleShareRoom} disabled={!myId} className="w-full bg-slate-900/70 border border-emerald-500/40 rounded-2xl py-2.5 text-sm font-black text-emerald-300 transition-all hover:bg-slate-900/90 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-slate-900/70">📋 复制分享</button>
          </div>
        </div>
      </div>
    </div>
  );

  const renderJoinModal = () => (
    <div className="absolute inset-0 z-[900] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-300">
      <div className="w-full max-w-md bg-slate-900 border border-emerald-500/30 rounded-[2rem] p-6 landscape:p-4 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-emerald-400 font-black">加入好友</p>
            <h2 className="text-2xl font-black chinese-font text-slate-100 mt-1">输入房号或邀请链接</h2>
          </div>
          <button onClick={() => setShowJoinModal(false)} className="text-slate-100 hover:text-slate-100 text-2xl leading-none">✕</button>
        </div>
        <p className="text-sm text-slate-400 mb-4">可直接粘贴好友分享的链接，我们会自动识别其中的房号。</p>
        <div className="flex gap-3 mb-3">
          <input value={targetId} onChange={e => setTargetId(e.target.value)} placeholder="例如：1234 或 https://..." className="flex-1 bg-slate-950 border border-white/10 rounded-2xl px-4 py-3 font-bold text-emerald-400 placeholder:text-slate-600 focus:border-emerald-500/60 focus:outline-none transition-all" />
          <button onClick={() => joinRoom()} disabled={!isNicknameReady} className="px-5 py-3 rounded-2xl bg-emerald-600 font-black text-white text-base transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100">加入</button>
        </div>
        <p className="text-[11px] text-slate-400">提示：加入前请先设置昵称；若好友房间号过期，请让对方重新开局。</p>
      </div>
    </div>
  );

  const renderHistoryModal = () => (
    <div className="absolute inset-0 z-[1000] bg-black/80 backdrop-blur-md flex items-center justify-center p-6 animate-in fade-in duration-300">
      <div className="bg-slate-900 border border-emerald-500/30 p-8 landscape:p-5 rounded-[2rem] max-w-4xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        <h2 className="text-3xl font-black chinese-font text-emerald-500 mb-6 flex justify-between items-center shrink-0">
          <span>对局实录</span>
          <button onClick={() => setShowHistory(false)} className="text-slate-100">✕</button>
        </h2>
        <div className="flex-1 overflow-y-auto custom-scrollbar pr-1.5 space-y-4">
          {gameState.roundHistory.length === 0 ? (
            <div className="text-center py-20 text-slate-600 font-black chinese-font italic">尚无出牌记录</div>
          ) : (
            gameState.roundHistory.map((trick, tidx) => {
              const winner = [...trick].sort((a,b) => b.strength - a.strength)[0].playerId;
              return (
                <div key={tidx} className="p-4 bg-white/5 rounded-2xl border border-white/5 flex flex-col gap-3">
                  <div className="flex justify-between items-center border-b border-white/5 pb-2 flex-wrap gap-2">
                    <span className="text-xs font-black text-slate-100 uppercase">第 {tidx + 1} 轮</span>
                    <span className="text-xs font-black text-emerald-500 chinese-font">赢家: {getPlayerName(winner)}</span>
                  </div>
                  <div className="overflow-x-auto custom-scrollbar pb-1.5">
                    <div className="flex gap-3 min-w-max">
                      {trick.map((p, pidx) => (
                        <div key={pidx} className="bg-slate-900/40 rounded-2xl border border-white/5 p-3 flex flex-col gap-2 min-w-[140px]">
                          <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-black text-slate-100 truncate">{getPlayerName(p.playerId)}</span>
                            <span className="text-[9px] text-slate-100 uppercase whitespace-nowrap">{p.type === 'discard' ? '扣牌' : `${p.cards.length} 张`}</span>
                          </div>
                          {p.type === 'discard' ? (
                            <div className="w-full py-2 text-center text-[11px] text-slate-100 border border-dashed border-white/10 rounded-lg">
                              无出牌
                            </div>
                          ) : (
                            <div className="flex items-center gap-1 overflow-x-auto custom-scrollbar pb-1">
                              {p.cards.map(c => (
                                <div key={c.id} className="flex-shrink-0">
                                  <PlayingCard card={c} size="small" />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
        <button onClick={() => setShowHistory(false)} className="mt-6 w-full py-4 bg-slate-800 rounded-2xl font-black text-xl chinese-font active:scale-95 transition-all">关 闭</button>
      </div>
    </div>
  );

  const renderRulesModal = () => (
    <div className="absolute inset-0 z-[1000] bg-slate-950/95 backdrop-blur-md flex items-center justify-center p-6 animate-in fade-in duration-300">
      <div className="bg-slate-900 border border-emerald-500/30 p-8 rounded-[2rem] max-w-2xl w-full max-h-[80vh] overflow-y-auto custom-scrollbar shadow-2xl">
        <h2 className="text-3xl font-black chinese-font text-emerald-500 mb-6 border-b border-white/5 pb-4 flex justify-between items-center">
          <span>宣坨坨 玩法规则</span>
          <button onClick={() => setShowRules(false)} className="text-slate-100">✕</button>
        </h2>
        <div className="space-y-6 text-slate-100 leading-relaxed font-medium">
          <section>
            <h3 className="text-emerald-400 font-black mb-2 flex items-center gap-2">🔹 牌组构成</h3>
            <p>共24张牌：红黑卒(7)、马(8)、相(9)、尔(10)、曲(JQK)、大王(RJ)、小王(SJ)。每人起手8张。</p>
          </section>
          <section>
            <h3 className="text-emerald-400 font-black mb-2 flex items-center gap-2">🔹 出牌规则</h3>
            <p>可出单张、对子、三张（特定组合）。下家必须跟同数量的牌，且牌力必须严格大于当前场上最大牌。若没有能压过的牌则必须扣牌。</p>
          </section>
          <section>
            <h3 className="text-emerald-400 font-black mb-2 flex items-center gap-2">🔹 博弈阶段</h3>
            <p>发牌后可选择“加倍”或“抢收牌”。抢收牌者成为先手，且全局结算倍率翻倍。轮到领先出牌时可发起“扣了”博弈。</p>
          </section>
          <section>
            <h3 className="text-emerald-400 font-black mb-2 flex items-center gap-2">🔹 胜负结算</h3>
            <p>按收回的牌数计分：9张“刚够”(1分)，15张“五了”(2分)，18张“此了”(3分)。不满9张为输。</p>
          </section>
        </div>
        <button onClick={() => setShowRules(false)} className="mt-8 w-full py-4 bg-emerald-600 rounded-2xl font-black text-xl chinese-font active:scale-95 transition-all">我 懂 了</button>
      </div>
    </div>
  );

  const renderTableSlot = (pid: PlayerId, position: 'left' | 'right' | 'bottom') => {
    const play = gameState.table.find(p => p.playerId === pid);
    if (!play) return <div className="w-9 h-14 md:w-16 md:h-24 rounded-xl border-2 border-dashed border-white/5 flex items-center justify-center text-slate-800 text-[8px] uppercase font-black tracking-tighter">Wait...</div>;

    const animationClass = position === 'bottom' ? 'play-animation-bottom' : (position === 'left' ? 'play-animation-left' : 'play-animation-right');

    return (
      <div className={`flex transition-transform duration-500 ${animationClass}`}>
        {play.cards.map((c, i) => (
          <div
            key={c.id}
            style={{
              marginLeft: i === 0 ? 0 : '-0.85rem',
              zIndex: i
            }}
            className="drop-shadow-2xl"
          >
            <PlayingCard card={c} size="small" isBack={play.type === 'discard'} />
          </div>
        ))}
      </div>
    );
  };

  const renderBettingOverlay = () => {
    if (gameState.phase !== GamePhase.BETTING) return null;
    const isMyTurn = gameState.betTurn === myPlayerId;
    
    return (
      <div className="absolute inset-0 z-[400] bg-slate-950/60 backdrop-blur-sm flex flex-col items-center justify-center p-6 animate-in zoom-in">
        <div className="bg-slate-900 border border-emerald-500/40 p-10 rounded-[3rem] shadow-2xl text-center max-w-md w-full relative">
          <div className="absolute top-[-40px] landscape:top-[-20px] left-1/2 -translate-x-1/2 bg-emerald-500 text-slate-950 font-black px-6 py-2 rounded-full shadow-xl">
            {isMyTurn ? "轮到您决策" : `等待 ${getPlayerName(gameState.betTurn!)} 决策...`}
          </div>
          
          <div className="mb-6">
            <div className="text-slate-100 text-xs uppercase tracking-widest mb-2">当前倍率</div>
            <div className="flex justify-center gap-4">
               <div className="bg-black/40 px-4 py-2 rounded-xl border border-white/5">
                 <span className="text-[10px] text-slate-100 block">全局抢牌</span>
                 <span className="text-xl font-black text-emerald-400">x{gameState.grabMultiplier}</span>
               </div>
               {gameState.grabber && (
                 <div className="bg-red-600/20 px-4 py-2 rounded-xl border border-red-500/30">
                   <span className="text-[10px] text-red-400 block">抢牌者</span>
                   <span className="text-sm font-black text-white">{getPlayerName(gameState.grabber)}</span>
                 </div>
               )}
            </div>
          </div>

          {isMyTurn ? (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-3 gap-3">
                <button onClick={() => handleBetDecision(1, false)} className="py-4 bg-slate-800 rounded-2xl font-black text-sm transition-all border border-white/5">不加倍</button>
                <button onClick={() => handleBetDecision(2, false)} className="py-4 bg-emerald-600/20 text-emerald-400 border border-emerald-500/20 rounded-2xl font-black text-sm transition-all">加倍 x2</button>
                <button onClick={() => handleBetDecision(4, false)} className="py-4 bg-orange-600/20 text-orange-400 border border-orange-500/20 rounded-2xl font-black text-sm transition-all">超倍 x4</button>
              </div>
              <button 
                onClick={() => handleBetDecision(gameState.multipliers[myPlayerId], true)} 
                className={`py-4 rounded-2xl font-black chinese-font transition-all text-lg bg-red-600 shadow-xl text-white`}
              >
                {gameState.grabber ? "顶 抢 收 牌 (倍数再翻倍)" : "抢 收 牌 (全局 x2)"}
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center py-6 gap-3">
               <div className="w-10 h-10 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin"></div>
               <span className="text-xs font-black text-emerald-400">对手正在深思熟虑...</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  const targetPlay = gameState.table.length > 0 ? gameState.table[0] : null;
  const currentMaxStr = gameState.table.reduce((max, p) => Math.max(max, p.strength), -1);
  const selectedStrength = calculatePlayStrength(selectedCards);
  
  const canFollow = useMemo(() => {
    if (gameState.turn !== myPlayerId || gameState.phase !== GamePhase.PLAYING) return false;
    if (!targetPlay) return selectedStrength.type !== 'discard';
    return selectedStrength.type === targetPlay.type && 
           selectedCards.length === targetPlay.cards.length && 
           selectedStrength.strength > currentMaxStr;
  }, [gameState.turn, gameState.phase, targetPlay, selectedStrength, selectedCards.length, currentMaxStr, myPlayerId]);

  const mustFollowIfPossible = useMemo(() => {
    if (gameState.turn !== myPlayerId || !targetPlay || gameState.phase !== GamePhase.PLAYING) return false;
    const validPlays = getValidPlays(gameState.hands[myPlayerId], targetPlay, currentMaxStr);
    return validPlays.length > 0;
  }, [gameState.turn, targetPlay, gameState.phase, gameState.hands, currentMaxStr, myPlayerId]);

  const canDiscard = useMemo(() => {
    if (gameState.turn !== myPlayerId || !targetPlay || gameState.phase !== GamePhase.PLAYING) return false;
    return selectedCards.length === targetPlay.cards.length && !mustFollowIfPossible;
  }, [gameState.turn, targetPlay, selectedCards.length, mustFollowIfPossible, gameState.phase, myPlayerId]);

  const canInitiateKouLe = useMemo(() => {
    return gameState.phase === GamePhase.PLAYING && 
           gameState.turn === myPlayerId && 
           gameState.table.length === 0 && 
           gameState.kouLeInitiator === null &&
           !gameState.kouLeUsedThisTrick;
  }, [gameState.phase, gameState.turn, gameState.table.length, gameState.kouLeInitiator, gameState.kouLeUsedThisTrick, myPlayerId]);

  return (
    <div className="h-screen w-full flex flex-col bg-slate-950 text-slate-100 overflow-hidden relative">
      {gameState.phase === GamePhase.LOBBY && renderLobby()}
      {showJoinModal && renderJoinModal()}
      {showRules && renderRulesModal()}
      {showHistory && renderHistoryModal()}
      
      {gameState.phase === GamePhase.WAITING && (
         <div className="absolute inset-0 z-[400] bg-slate-950/95 backdrop-blur-2xl flex flex-col items-center justify-center p-6">
            <div className="flex flex-col items-center gap-2 mb-10">
               <h2 className="text-2xl font-black chinese-font text-emerald-500">等待备战中...</h2>
               {isHost && (
                  <div className="flex flex-col items-center gap-1 landscape:flex-row landscape:gap-2">
                    <button onClick={handleShareRoom} className="px-4 py-1.5 bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 rounded-full text-[10px] font-black transition-all flex items-center gap-2">🔗 复制房间邀请链接</button>
                  </div>
               )}
            </div>
            <div className="flex items-center justify-center gap-8 md:gap-24 mb-16">
              {orientation.waitingOrder.map((id, idx) => (
                <div key={id} className={`flex flex-col items-center gap-4 ${idx === 1 ? 'mt-8' : ''}`}>
                   <div className={`w-20 h-20 md:w-28 md:h-28 rounded-full border-2 flex items-center justify-center text-4xl shadow-2xl transition-all ${id === myPlayerId ? 'border-emerald-500 bg-slate-800' : (slots[id].type === 'empty' ? 'border-dashed border-slate-700 bg-slate-900/50 grayscale' : 'border-emerald-500 bg-slate-800')}`}>
                      {id === myPlayerId ? '👤' : (slots[id].type === 'empty' ? '?' : (slots[id].type === 'ai' ? '🤖' : '侠'))}
                   </div>
                   <div className="text-center">
                      <div className="text-xs font-black text-slate-100 chinese-font">{getPlayerName(id)}</div>
                      <div className="flex items-center justify-center gap-1 text-[10px] font-bold text-yellow-500 mt-1">
                        🪙 {gameState.starCoins[id]}
                      </div>
                      {isHost && id !== PlayerId.PLAYER && slots[id].type !== 'human' && (
                        <button onClick={() => setSlots(prev => { 
                          const n = {...prev}; 
                          if(n[id].type === 'empty') { 
                            const usedNames = Object.values(prev).map((s: SlotInfo) => s.name);
                            const name = pickAiName(usedNames); 
                            n[id] = { type: 'ai', name }; 
                            setGameState(gs => ({...gs, aiNames: {...gs.aiNames, [id]: name}})); 
                          } else { 
                            n[id] = { type: 'empty', name: '等待加入...' }; 
                            setGameState(gs => ({...gs, aiNames: {...gs.aiNames, [id]: 'AI'}})); 
                          } 
                          return n; 
                        })} className="mt-2 text-[10px] text-emerald-500">{slots[id].type === 'empty' ? '+ 添加 AI' : '× 移除 AI'}</button>
                      )}
                   </div>
                </div>
              ))}
            </div>
            {isHost ? (
               <div className="flex flex-col gap-2 w-full max-sm pb-16 landscape:pb-20">
                  <button onClick={handleShareRoom} className="py-2.5 px-4 rounded-2xl bg-slate-800 border border-white/10 text-[11px] font-black text-emerald-400 flex items-center justify-center gap-2 active:scale-95 transition-all landscape:w-full">
                    🔗 分享房间邀请链接
                  </button>
                  <button onClick={() => initGame()} disabled={slots[PlayerId.AI_LEFT].type === 'empty' || slots[PlayerId.AI_RIGHT].type === 'empty'} className={`px-14 py-4 rounded-3xl font-black text-xl transition-all chinese-font shadow-2xl ${slots[PlayerId.AI_LEFT].type !== 'empty' && slots[PlayerId.AI_RIGHT].type !== 'empty' ? 'bg-emerald-600 active:scale-95' : 'bg-slate-800 text-slate-600 opacity-50 cursor-not-allowed'}`}>开 始 游 戏</button>
                  <button onClick={quitToLobby} className="py-3 text-slate-100 text-xs font-black transition-all uppercase tracking-widest">解散房间并返回</button>
               </div>
            ) : (<div className="text-emerald-500 animate-pulse font-black chinese-font text-xl">房主正在配置席位...</div>)}
         </div>
      )}
      {gameState.phase === GamePhase.DEALING && (
        <div className="absolute inset-0 z-[600] bg-slate-950/80 backdrop-blur-xl flex flex-col items-center justify-center p-6 overflow-hidden">
          <div className="relative w-64 h-64 mb-12 flex items-center justify-center">
            <div className="absolute w-24 h-36 bg-white rounded-lg shadow-2xl border border-slate-300 transform -rotate-12 animate-shuffle-1"></div>
            <div className="absolute w-24 h-36 bg-white rounded-lg shadow-2xl border border-slate-300 transform rotate(12deg) animate-shuffle-2"></div>
            <div className="absolute w-24 h-36 bg-emerald-500 rounded-lg shadow-2xl border border-emerald-400 flex items-center justify-center text-4xl animate-deal-cards">🎴</div>
          </div>
          <h2 className="text-3xl font-black chinese-font text-emerald-400 animate-pulse tracking-widest">正在洗牌发牌...</h2>
        </div>
      )}
      
      {renderBettingOverlay()}

      <div className="flex-1 flex flex-col h-full relative" onClick={() => setSelectedCards([])}>
        <div className="h-12 flex items-center justify-between px-2 bg-slate-900/80 backdrop-blur-md border-b border-white/5 z-50">
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="flex flex-col">
              <span className="text-sm font-black text-emerald-500 chinese-font leading-tight">宣坨坨</span>
              <span className="text-[6px] opacity-40 uppercase tracking-wider leading-none">NETWORK V2.0</span>
            </div>
            <button onClick={() => setShowRules(true)} className="w-7 h-7 flex items-center justify-center bg-slate-800 rounded-md text-[11px] font-black text-slate-100 active:scale-90 transition-all border border-white/5">规</button>
            <button onClick={() => setShowHistory(true)} className="w-7 h-7 flex items-center justify-center bg-slate-800 rounded-md border border-white/5 font-black text-[11px] chinese-font transition-all active:scale-90 text-slate-100">录</button>
            <div className="text-[9px] font-mono bg-black/60 px-2 py-1 rounded-md border border-white/10 flex items-center gap-1"><span className="text-yellow-500 text-xs">🪙</span><span className="font-bold text-yellow-100">{gameState.starCoins[myPlayerId]}</span></div>
            <div className="px-2 py-0.5 bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded text-[9px] font-black">已收: {(gameState.collected[myPlayerId] as Card[]).length}</div>
            <div className="px-2 py-0.5 bg-slate-800 border border-white/10 rounded text-[9px] font-black text-slate-100 flex items-center gap-1">
              <span>🪪 江湖名</span>
              <span className="text-emerald-300">{displayNickname}</span>
            </div>
          </div>

          <div className="flex-1 flex justify-start items-center gap-1 overflow-hidden px-1 min-w-0">
            <div className="px-1.5 py-0.5 bg-yellow-600/20 border border-yellow-500/30 rounded text-[9px] font-black text-yellow-400 whitespace-nowrap shrink-0">
              <span>个人倍率</span>
              <span className="ml-0.5">x{gameState.multipliers[myPlayerId]}</span>
            </div>
            <div className="px-1.5 py-0.5 bg-red-600/20 border border-red-500/30 rounded text-[9px] font-black text-red-400 whitespace-nowrap shrink-0">
              <span>抢收连锁</span>
              <span className="ml-0.5">x{gameState.grabMultiplier}</span>
            </div>
            {gameState.grabber === myPlayerId && (
              <div className="px-1.5 py-0.5 bg-red-600/15 border border-red-500/40 rounded text-[9px] font-black text-red-200 whitespace-nowrap shrink-0 flex items-center gap-0.5 shadow-lg animate-pulse">
                <span>🎴 抢收翻倍</span>
                <span className="text-white text-[8px]">先手</span>
              </div>
            )}
            {(gameState.challengers[myPlayerId] || 0) > 0 && (
              <div className="bg-orange-600 px-1.5 py-0.5 rounded-full shadow-lg shrink-0 border border-orange-400/30">
                <span className="text-[7px] font-black text-white whitespace-nowrap">🔥x{gameState.challengers[myPlayerId]}</span>
              </div>
            )}
            <div key={gameState.logs[0]} className="bg-slate-950/40 px-2 py-1 rounded-full border border-emerald-500/20 shrink-0 min-w-0">
               <span className="text-[9px] font-black text-emerald-400 chinese-font truncate block max-w-[120px]">{gameState.logs[0] || '对局进行中...'}</span>
            </div>
          </div>

          <div className="w-20 shrink-0"></div>
        </div>

        <div className="flex-1 relative flex items-center justify-center py-8 landscape:py-4">
          {[orientation.topLeft, orientation.topRight].map((id, idx) => (
            <div key={id} className={`absolute top-8 ${idx === 0 ? 'left-4' : 'right-4'} flex flex-col items-center gap-2 z-30`}>
              <div className="relative">
                <div className={`w-12 h-12 md:w-16 md:h-16 rounded-2xl border-2 bg-slate-900 flex items-center justify-center text-2xl md:text-3xl shadow-2xl transition-all duration-500 ${gameState.turn === id && gameState.phase === GamePhase.PLAYING ? 'border-emerald-500 ring-4 ring-emerald-500/20 scale-110' : 'border-white/10'}`}>{slots[id].type === 'human' ? '侠' : (slots[id].type === 'ai' ? '🤖' : '👴')}</div>
                
                {/* 星光币 - 左上角 */}
                <div className="absolute -top-3 -left-3 bg-slate-950/80 border border-yellow-500/50 rounded-full px-1.5 py-0.5 flex items-center gap-0.5 shadow-lg z-20">
                  <span className="text-[8px] font-black text-yellow-400">🪙 {gameState.starCoins[id]}</span>
                </div>
                
                {/* 宣状态 - 右上角 */}
                {(gameState.challengers[id] || 0) > 0 && (
                  <div className="absolute -top-4 -right-4 bg-orange-600 border-2 border-white text-white font-black text-[10px] w-9 h-9 flex items-center justify-center rounded-full shadow-lg animate-bounce z-30">
                    宣x{gameState.challengers[id]}
                  </div>
                )}
                
                {/* 个人倍率 - 右下角 */}
                {gameState.multipliers[id] > 1 && (
                  <div className="absolute -bottom-2 -right-2 bg-yellow-500 text-black font-black text-[10px] px-1.5 py-0.5 rounded-md shadow-sm border border-slate-900 z-20 flex items-center gap-0.5">
                    <span>个人倍率</span>
                    <span>x{gameState.multipliers[id]}</span>
                  </div>
                )}
                
                {/* 抢收牌状态 - 左下角 */}
                {gameState.grabber === id && (
                  <div className="absolute -bottom-2 -left-2 bg-red-600/15 text-red-100 text-[8px] px-1.5 py-0.5 rounded-md font-black shadow-lg animate-pulse whitespace-nowrap z-20 border border-red-500/40 flex items-center gap-0.5">
                    <span>抢收翻倍</span>
                    <span className="text-red-50 text-[7px]">先手</span>
                  </div>
                )}
              </div>
              <div className="flex flex-col items-center gap-0.5 text-center">
                <span className="text-[10px] md:text-[11px] font-black text-slate-100 chinese-font">{getPlayerName(id)} ({gameState.hands[id].length})</span>
                <div className="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full text-[8px] md:text-[9px] font-black">已收: {(gameState.collected[id] as Card[]).length}</div>
              </div>
            </div>
          ))}
          <div className="absolute top-2 left-0 right-0 flex items-center justify-center gap-3 md:gap-24 z-20 w-full max-w-5xl px-2 scale-90 md:scale-100 mx-auto">
            {renderTableSlot(orientation.topLeft, 'left')}
            {renderTableSlot(orientation.bottom, 'bottom')}
            {renderTableSlot(orientation.topRight, 'right')}
          </div>
          
          {gameState.phase === GamePhase.KOU_LE_DECISION && (
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-[150] flex items-center justify-center p-6 animate-in fade-in">
              <div className="bg-slate-900 border border-emerald-500/40 p-8 rounded-3xl max-w-sm w-full text-center shadow-2xl">
                <div className="text-3xl mb-4">⚖️</div>
                <h3 className="text-xl font-black text-emerald-500 chinese-font mb-2">"扣了"博弈中</h3>
                {(() => {
                  const initiator = gameState.kouLeInitiator;
                  const respondents = getNextRespondents(initiator!);
                  const currentDecider = respondents.find(id => gameState.kouLeResponses[id] === null);
                  const initiatorName = initiator === myPlayerId ? '您' : getPlayerName(initiator!);
                  const deciderName = currentDecider === myPlayerId ? '您' : (currentDecider ? getPlayerName(currentDecider) : '...');

                  return (
                    <>
                      <p className="text-sm text-slate-100 mb-6">{initiatorName} 发起博弈，当前 {deciderName} 表态...</p>
                      {currentDecider === myPlayerId ? (
                        <div className="flex gap-4 animate-in slide-in-from-bottom duration-500">
                          <button onClick={() => handleKouLeResponseAction('agree')} className="flex-1 py-4 bg-slate-800 rounded-xl font-black transition-all">扣了(同意)</button>
                          <button onClick={() => handleKouLeResponseAction('challenge')} className="flex-1 py-4 bg-orange-600 rounded-xl font-black transition-all">宣(挑战)</button>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center py-4 text-emerald-500"><div className="w-8 h-8 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin mb-3"></div><span className="text-xs font-black">等待对方思考...</span></div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {/* 手牌和按钮区域 - 放在游戏桌面底部 */}
          <div className="absolute -bottom-8 left-0 right-0 flex flex-col items-center z-40 px-2">
            {/* 操作按钮 */}
            <div className="flex justify-center items-center gap-1 w-full max-w-3xl mb-2">
              <button onClick={() => handleAction(true)} disabled={!canDiscard} className={`flex-1 max-w-[65px] h-6 md:h-9 flex items-center justify-center rounded-md font-black text-[9px] md:text-sm transition-all border ${canDiscard ? 'bg-indigo-600 border-indigo-500 active:scale-95 shadow-md text-white' : 'bg-slate-800/50 border-slate-700 text-slate-600 opacity-50 cursor-not-allowed'}`}>扣牌</button>
              <button onClick={handleHint} disabled={gameState.phase !== GamePhase.PLAYING || gameState.turn !== myPlayerId} className={`flex-1 max-w-[65px] h-6 md:h-9 flex items-center justify-center rounded-md font-black text-[9px] md:text-sm transition-all border ${gameState.turn === myPlayerId && gameState.phase === GamePhase.PLAYING ? 'bg-emerald-600 border-emerald-500 active:scale-95 shadow-md text-white' : 'bg-slate-800/50 border-slate-700 text-slate-600 opacity-50 cursor-not-allowed'}`}>提示</button>
              {canInitiateKouLe && (
                <button onClick={handleInitiateKouLeAction} className="flex-1 max-w-[55px] h-6 md:h-9 flex items-center justify-center bg-red-600 border border-red-500 rounded-md font-black text-[9px] md:text-sm transition-all active:scale-95 text-white shadow-md animate-pulse">扣了</button>
              )}
              <button onClick={() => handleAction(false)} disabled={!canFollow} className={`flex-1 max-w-[65px] h-6 md:h-9 flex items-center justify-center rounded-md font-black text-[9px] md:text-sm transition-all border ${canFollow ? 'bg-orange-600 border-orange-500 active:scale-95 shadow-md text-white' : 'bg-slate-800/50 border-slate-700 text-slate-600 opacity-50 cursor-not-allowed'}`}>{gameState.table.length === 0 ? '出牌' : '跟牌'}</button>
            </div>

            {/* 手牌区域 */}
            <div className="flex justify-center items-end w-full overflow-x-auto custom-scrollbar">
              <div className="flex items-end justify-center min-w-max pb-0">
                {playerHandSorted.map((c, i) => {
                  const isSel = selectedCards.some(sc => sc.id === c.id);
                  const cardCount = playerHandSorted.length;
                  const overlapAmount = cardCount <= 5 ? '-0.5rem' : (cardCount === 6 ? '-0.6rem' : (cardCount === 7 ? '-0.7rem' : '-0.8rem'));
                  const hoverActive = !isTouchDevice && hoverCardId === c.id;
                  const baseScale = isSel ? 0.72 : 0.6;
                  const scale = baseScale + (hoverActive ? 0.04 : 0);
                  const baseTranslate = isSel ? -20 : 0;
                  const translateY = baseTranslate + (!isSel && hoverActive ? -6 : 0);
                  return (
                    <div
                      key={c.id}
                      onClick={(e) => { 
                        e.stopPropagation(); 
                        setSelectedCards(prev => isSel ? prev.filter(sc => sc.id !== c.id) : [...prev, c]); 
                      }}
                      onMouseEnter={() => { if (!isTouchDevice) setHoverCardId(c.id); }}
                      onMouseLeave={() => { if (!isTouchDevice) setHoverCardId(prev => prev === c.id ? null : prev); }}
                      onTouchStart={() => setHoverCardId(null)}
                      className="transition-[transform,filter,box-shadow] duration-300 ease-out cursor-pointer relative flex-shrink-0 self-end will-change-transform transform-gpu"
                      style={{ 
                        marginLeft: i === 0 ? 0 : overlapAmount, 
                        zIndex: isSel ? 100 + i : i,
                        transform: `translateY(${translateY}px) scale(${scale})`
                      }}
                    >
                      <div className={isSel ? 'drop-shadow-[0_4px_20px_rgba(16,185,129,0.6)] filter brightness-105' : 'drop-shadow-[0_2px_8px_rgba(0,0,0,0.3)]'}>
                        <PlayingCard card={c} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {gameState.phase === GamePhase.SETTLEMENT && (
        <div className="absolute inset-0 z-[300] bg-slate-950/98 flex items-center justify-center p-4 backdrop-blur-3xl animate-in zoom-in">
          <div className="max-w-xl w-full flex flex-col bg-slate-900 border border-emerald-500/40 p-5 rounded-3xl shadow-2xl text-center">
            <h2 className="text-2xl font-black chinese-font text-emerald-500 mb-4 tracking-widest">对局结算</h2>

            {/* 结算内容 */}
            <div className="space-y-2 mb-4">
              {settlementData.map(res => (
                <div key={res.id} className={`relative flex items-center justify-between p-3 rounded-xl border-2 ${res.netGain < 0 ? 'border-red-500/50 bg-red-500/10' : (res.netGain > 0 ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-white/10 bg-white/5')}`}>

                  {/* 超大胜负标识 */}
                  <div className={`absolute -left-3 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full flex items-center justify-center font-black text-xl shadow-xl ${res.netGain > 0 ? 'bg-emerald-500 text-white' : (res.netGain < 0 ? 'bg-red-500 text-white' : 'bg-slate-700 text-slate-100')}`}>
                    {res.netGain > 0 ? '胜' : (res.netGain < 0 ? '负' : '平')}
                  </div>

                  {/* 左侧信息 */}
                  <div className="flex-1 flex flex-col items-start ml-10 gap-0.5">
                    <span className="font-black text-lg chinese-font">{getPlayerName(res.id)}</span>
                    <div className="flex gap-1.5 items-center flex-wrap">
                      <span className={`font-black px-1.5 py-0.5 rounded text-[10px] ${res.coins > 0 ? 'bg-emerald-500/30 text-emerald-300' : 'bg-slate-700 text-slate-100'}`}>{res.level}</span>
                      <span className="text-[10px] text-slate-100">{res.cards}张</span>
                      <span className="text-[10px] text-yellow-500 font-bold">x{res.finalMultiplier}</span>
                    </div>
                  </div>

                  {/* 右侧星光币变化 */}
                  <div className="flex flex-col items-end">
                    <span className={`text-2xl font-black leading-none ${res.netGain > 0 ? 'text-emerald-400' : (res.netGain < 0 ? 'text-red-400' : 'text-slate-100')}`}>
                      {res.netGain > 0 ? `+${res.netGain}` : res.netGain}
                    </span>
                    <span className="text-[9px] text-yellow-500 mt-0.5">🪙</span>
                  </div>
                </div>
              ))}
            </div>

            {/* 按钮区 */}
            <div className="flex gap-2">
              {isHost && (
                <button
                  onClick={() => {
                    setGameState(prev => {
                      const next = { ...prev, phase: GamePhase.WAITING };
                      syncStateToClients(next);
                      return next;
                    });
                  }}
                  className="flex-1 py-2.5 bg-emerald-600 rounded-lg font-black text-sm shadow-lg transition-all chinese-font active:scale-95"
                >
                  再来一局
                </button>
              )}
              <button onClick={quitToLobby} className="flex-1 py-2.5 bg-slate-800 text-slate-100 rounded-lg text-xs font-black transition-all active:scale-95">返回大厅</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
