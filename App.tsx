import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { 
  Card, PlayerId, GamePhase, GameState, Play, 
  RewardLevel, NetworkMessage 
} from './types';
import { 
  createDeck, INITIAL_STAR_COINS 
} from './constants';
import { 
  calculatePlayStrength, getValidPlays, getRewardInfo, 
  aiDecidePlay, aiEvaluateKouLe, aiDecideBet,
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

const AI_NAME_POOL = ['王铁柱', '李翠花', '赵大壮', '孙木耳', '钱多多', '周公瑾', '吴二娃', '郑牛牛', '刘大脑袋', '马马虎虎', '张三丰', '李探花', '阿珂', '韦小宝', '令狐冲'];

interface SlotInfo {
  type: 'empty' | 'human' | 'ai';
  peerId?: string;
  name: string;
}

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

const App: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>(INITIAL_GAME_STATE());
  const [myId, setMyId] = useState<string>('');
  const [targetId, setTargetId] = useState<string>('');
  const [isHost, setIsHost] = useState<boolean>(false);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [showRules, setShowRules] = useState<boolean>(false);
  
  const [slots, setSlots] = useState<Record<PlayerId, SlotInfo>>({
    [PlayerId.PLAYER]: { type: 'human', name: '我' },
    [PlayerId.AI_LEFT]: { type: 'empty', name: '等待加入...' },
    [PlayerId.AI_RIGHT]: { type: 'empty', name: '等待加入...' },
  });

  const peerRef = useRef<any>(null);
  const connectionsRef = useRef<Record<string, any>>({});
  const [selectedCards, setSelectedCards] = useState<Card[]>([]);
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  const updatedCoinsForRound = useRef<boolean>(false);

  const playerHandSorted = useMemo(() => {
    return [...gameState.hands[PlayerId.PLAYER]].sort((a, b) => a.strength - b.strength);
  }, [gameState.hands]);

  const addLog = useCallback((msg: string) => {
    setGameState(prev => ({ ...prev, logs: [msg, ...prev.logs].slice(0, 30) }));
  }, []);

  const getNextRespondents = useCallback((initiator: PlayerId) => {
    const order = [PlayerId.PLAYER, PlayerId.AI_RIGHT, PlayerId.AI_LEFT];
    const idx = order.indexOf(initiator);
    const sorted: PlayerId[] = [];
    for(let i = 1; i < 3; i++) {
        sorted.push(order[(idx + i) % 3]);
    }
    return sorted;
  }, []);

  const broadcast = useCallback((type: string, payload: any) => {
    Object.values(connectionsRef.current).forEach((c) => {
      const conn = c as any;
      if (conn.open) conn.send({ type, payload, senderId: peerRef.current?.id });
    });
  }, []);

  const sendToHost = useCallback((type: string, payload: any) => {
    if (isHost) return;
    const hostConn = Object.values(connectionsRef.current)[0] as any;
    if (hostConn && hostConn.open) hostConn.send({ type, payload, senderId: peerRef.current?.id });
  }, [isHost]);

  // 初始化 PeerJS
  useEffect(() => {
    if (typeof Peer === 'undefined') return;
    
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam) setTargetId(roomParam);

    const peer = new Peer();
    peerRef.current = peer;

    peer.on('open', (id: string) => {
      setMyId(id);
      addLog(`🌐 你的联机 ID 已就绪: ${id}`);
    });

    peer.on('connection', (conn: any) => {
      connectionsRef.current[conn.peer] = conn;
      conn.on('data', (data: NetworkMessage) => handleNetworkMessage(data));
      setConnectedPeers(prev => [...prev, conn.peer]);
    });

    return () => peer.destroy();
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

    if (gameState.kouLeInitiator) {
      const initiatorStat = stats.find(s => s.id === gameState.kouLeInitiator)!;
      const initiatorRes = results.find(r => r.id === gameState.kouLeInitiator)!;
      if (initiatorStat.coins > 0) {
        Object.entries(gameState.challengers).forEach(([chalId, val]) => {
          const chalCount = val as number;
          if (chalCount > 0) {
            const chalStat = stats.find(s => s.id === chalId)!;
            const chalRes = results.find(r => r.id === chalId)!;
            if (chalStat.coins === 0) {
              const riskAmount = (initiatorStat.coins * initiatorRes.finalMultiplier) * 2 * chalCount; 
              chalRes.netGain -= riskAmount;
              chalRes.multiplier = chalCount * 2;
              initiatorRes.netGain += riskAmount;
            }
          }
        });
      }
    }
    return results;
  }, [gameState.collected, gameState.kouLeInitiator, gameState.challengers, gameState.aiNames, gameState.multipliers, gameState.grabMultiplier]);

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
          broadcast('SYNC_STATE', newState);
          return newState;
        });
        updatedCoinsForRound.current = true;
      }

      const myRes = settlementData.find(r => r.id === PlayerId.PLAYER);
      if (myRes) {
        if (myRes.netGain > 0) SoundEngine.play('victory');
        else if (myRes.netGain < 0) SoundEngine.play('defeat');
        else SoundEngine.play('settle');
      }
    } else {
      updatedCoinsForRound.current = false;
    }
  }, [gameState.phase, settlementData, isHost, broadcast]);

  const initGame = useCallback((preservedStarter?: PlayerId) => {
    if (!isHost) return;
    setGameState(prev => {
      const s = { ...prev, phase: GamePhase.DEALING };
      broadcast('SYNC_STATE', s);
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
          kouLeResponses: { [PlayerId.PLAYER]: null, [PlayerId.AI_LEFT]: null, [PlayerId.AI_RIGHT]: null },
          multipliers: { [PlayerId.PLAYER]: 1, [PlayerId.AI_LEFT]: 1, [PlayerId.AI_RIGHT]: 1 },
          grabber: null, grabMultiplier: 1, betTurn: starter,
          betResponses: { [PlayerId.PLAYER]: false, [PlayerId.AI_LEFT]: false, [PlayerId.AI_RIGHT]: false },
          logs: [`🎴 发牌完成！进入博弈阶段，由 ${slots[starter].name} 先手决策。`, ...prev.logs].slice(0, 30),
          nextStarter: null
        };
        broadcast('SYNC_STATE', newState);
        return newState;
      });
      SoundEngine.play('deal');
    }, 2000);
  }, [isHost, broadcast, addLog, slots]);

  const resolveTrick = useCallback((currentTable: Play[], currentHands: Record<PlayerId, Card[]>) => {
    setGameState(prev => {
      const sortedPlays = [...currentTable].sort((a, b) => b.strength - a.strength);
      const winner = sortedPlays[0].playerId;
      const allTrickCards = currentTable.flatMap(p => p.cards);
      
      const newCollected = { ...prev.collected };
      newCollected[winner] = [...newCollected[winner], ...allTrickCards];
      
      const newLogs = [...prev.logs];
      newLogs.unshift(`✅ ${slots[winner].name} 赢得了本轮，收走 ${allTrickCards.length} 张牌。`);
      
      const roundHistory = [...prev.roundHistory, currentTable];
      
      let nextPhase = prev.phase;
      let nextTurn = winner;
      let nextStarter = winner;

      if (Object.values(currentHands).every((h: any) => h.length === 0)) {
        nextPhase = GamePhase.SETTLEMENT;
        const newState = { ...prev, collected: newCollected, logs: newLogs.slice(0, 30), phase: nextPhase, roundHistory, turn: nextTurn, starter: nextStarter, table: [] };
        if (isHost) broadcast('SYNC_STATE', newState);
        return newState;
      }
      
      const newState = { ...prev, collected: newCollected, logs: newLogs.slice(0, 30), roundHistory, turn: nextTurn, starter: nextStarter, table: [] };
      if (isHost) broadcast('SYNC_STATE', newState);
      return newState;
    });
    SoundEngine.play('win');
  }, [isHost, broadcast, slots]);

  const processPlayCards = useCallback((pid: PlayerId, cards: Card[], isDiscard: boolean) => {
    setGameState(prev => {
      if (prev.turn !== pid || prev.phase !== GamePhase.PLAYING) return prev;

      const pName = pid === PlayerId.PLAYER ? '您' : slots[pid].name;
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

      if (isTrickOver) {
        setTimeout(() => resolveTrick(newTable, newHands), 1200);
      }

      const nextS = { ...prev, hands: newHands, table: newTable, turn: nextTurn, logs: logs.slice(0, 30) };
      if (isHost) broadcast('SYNC_STATE', nextS);
      return nextS;
    });
    SoundEngine.play('play');
    setSelectedCards([]);
  }, [isHost, broadcast, slots, resolveTrick]);

  const processInitiateKouLe = useCallback((pid: PlayerId) => {
    setGameState(prev => {
      const newState = { 
        ...prev, 
        phase: GamePhase.KOU_LE_DECISION, 
        kouLeInitiator: pid, 
        kouLeResponses: { [PlayerId.PLAYER]: null, [PlayerId.AI_LEFT]: null, [PlayerId.AI_RIGHT]: null },
        logs: [`📣 ${pid === PlayerId.PLAYER ? '您' : slots[pid].name} 发起了“扣了”博弈！`, ...prev.logs].slice(0, 30)
      };
      if (isHost) broadcast('SYNC_STATE', newState);
      return newState;
    });
  }, [isHost, broadcast, slots]);

  const processKouLeResponse = useCallback((pid: PlayerId, response: 'agree' | 'challenge') => {
    setGameState(prev => {
      const newResponses = { ...prev.kouLeResponses, [pid]: response };
      const newChallengers = { ...prev.challengers };
      if (response === 'challenge') {
        newChallengers[pid] = (newChallengers[pid] || 0) + 1;
      }

      const pName = pid === PlayerId.PLAYER ? '您' : slots[pid].name;
      const logs = [`${pName} 选择了 ${response === 'agree' ? '同意(扣了)' : '宣(挑战)'}`, ...prev.logs];

      const initiator = prev.kouLeInitiator!;
      const respondents = getNextRespondents(initiator);

      if (response === 'challenge') {
        logs.unshift('⚔️ 有人选择“宣”，博弈达成，游戏继续！');
        const nextS = { ...prev, kouLeResponses: newResponses, challengers: newChallengers, logs: logs.slice(0, 30), phase: GamePhase.PLAYING };
        if (isHost) broadcast('SYNC_STATE', nextS);
        return nextS;
      }

      const isLastRespondent = respondents[respondents.length - 1] === pid;
      if (isLastRespondent) {
        const allAgreed = respondents.every(id => newResponses[id] === 'agree');
        if (allAgreed) {
          const anyWinner = Object.values(prev.collected).some((cards: any) => cards.length >= 9);
          if (anyWinner) {
            logs.unshift('🔄 全员同意“扣了”，已有玩家达标，直接进入结算。');
            const nextS = { ...prev, kouLeResponses: newResponses, logs: logs.slice(0, 30), phase: GamePhase.SETTLEMENT };
            if (isHost) broadcast('SYNC_STATE', nextS);
            return nextS;
          } else {
            logs.unshift('🔄 全员同意“扣了”，且无人达标，重新发牌。');
            setTimeout(() => initGame(prev.starter), 1500);
            const nextS = { ...prev, kouLeResponses: newResponses, logs: logs.slice(0, 30), phase: GamePhase.DEALING };
            if (isHost) broadcast('SYNC_STATE', nextS);
            return nextS;
          }
        }
      }

      const nextS = { ...prev, kouLeResponses: newResponses, challengers: newChallengers, logs: logs.slice(0, 30) };
      if (isHost) broadcast('SYNC_STATE', nextS);
      return nextS;
    });
  }, [isHost, broadcast, slots, getNextRespondents, initGame]);

  const processBet = useCallback((pid: PlayerId, multiplier: number, grab: boolean) => {
    setGameState(prev => {
      const newMults = { ...prev.multipliers, [pid]: multiplier };
      const newBetRes = { ...prev.betResponses, [pid]: true };
      let newGrabber = prev.grabber;
      let newGrabMultiplier = prev.grabMultiplier;
      let newStarter = prev.starter;

      const pName = pid === PlayerId.PLAYER ? '您' : slots[pid].name;
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
        logs.unshift(`🔥 博弈结束，对局开始！由 ${slots[newStarter].name} 先出牌。`);
      }

      const nextS = { ...prev, multipliers: newMults, betResponses: newBetRes, grabber: newGrabber, grabMultiplier: newGrabMultiplier, starter: newStarter, turn: newStarter, logs: logs.slice(0, 30), phase: nextPhase, betTurn: finalBetTurn };
      if (isHost) broadcast('SYNC_STATE', nextS);
      return nextS;
    });
    SoundEngine.play('bet');
  }, [isHost, broadcast, slots]);

  const handleNetworkMessage = useCallback((msg: NetworkMessage) => {
    switch (msg.type) {
      case 'SYNC_STATE': setGameState(msg.payload); break;
      case 'ACTION_PLAY': if (isHost) processPlayCards(msg.payload.playerId, msg.payload.cards, msg.payload.isDiscard); break;
      case 'ACTION_KOU_LE_INIT': if (isHost) processInitiateKouLe(msg.payload.playerId); break;
      case 'ACTION_KOU_LE_RES': if (isHost) processKouLeResponse(msg.payload.playerId, msg.payload.response); break;
      case 'ACTION_BET': if (isHost) processBet(msg.payload.playerId, msg.payload.multiplier, msg.payload.grab); break;
    }
  }, [isHost, processBet, processPlayCards, processInitiateKouLe, processKouLeResponse]);

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
    setGameState(INITIAL_GAME_STATE(gameState.starCoins));
    setIsHost(false);
    setConnectedPeers([]);
    setMyId(peerRef.current?.id || '');
  }, [gameState.starCoins]);

  const handleShareRoom = useCallback(() => {
    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${myId}`;
    navigator.clipboard.writeText(shareUrl);
    addLog("📋 邀请链接已复制！发给好友即可加入。");
  }, [myId, addLog]);

  const handleAction = useCallback((isDiscard: boolean) => {
    if (gameState.turn !== PlayerId.PLAYER) return;
    if (isHost) {
      processPlayCards(PlayerId.PLAYER, selectedCards, isDiscard);
    } else {
      sendToHost('ACTION_PLAY', { playerId: PlayerId.PLAYER, cards: selectedCards, isDiscard });
    }
  }, [isHost, gameState.turn, selectedCards, processPlayCards, sendToHost]);

  const handleHint = useCallback(() => {
    const targetPlay = gameState.table.length > 0 ? gameState.table[0] : null;
    const currentMaxStr = gameState.table.reduce((max, p) => Math.max(max, p.strength), -1);
    const valid = getValidPlays(gameState.hands[PlayerId.PLAYER], targetPlay, currentMaxStr);
    if (valid.length > 0) {
      setSelectedCards(valid[0]);
    } else {
      addLog("💡 提示：您没有比场上更大的牌了，请选择牌进行扣牌。");
    }
  }, [gameState.hands, gameState.table, addLog]);

  const renderLobby = () => (
    <div className="absolute inset-0 z-[500] bg-slate-950 flex flex-col items-center justify-center p-6 bg-[url('https://www.transparenttextures.com/patterns/dark-matter.png')] overflow-y-auto custom-scrollbar">
      <div className="text-center mt-8 mb-12 animate-in fade-in slide-in-from-top-10 duration-1000">
        <h1 className="text-7xl font-black chinese-font text-emerald-500 drop-shadow-[0_0_15px_rgba(16,185,129,0.5)] mb-2 leading-tight py-4">宣 坨 坨</h1>
        <p className="text-slate-500 uppercase tracking-[0.3em] text-xs font-bold">Traditional Shanxi Strategy Game</p>
      </div>
      
      <div className="flex flex-col gap-5 w-full max-sm animate-in fade-in slide-in-from-bottom-10 duration-1000 delay-300">
        <button onClick={() => { SoundEngine.init(); setIsHost(true); setGameState(prev => ({...prev, phase: GamePhase.WAITING})); }} className="group relative overflow-hidden py-6 rounded-3xl bg-emerald-600 font-black text-2xl chinese-font shadow-[0_10px_40px_-10px_rgba(16,185,129,0.5)] hover:scale-105 active:scale-95 transition-all">
          <span className="relative z-10">开 设 牌 局</span>
          <div className="absolute inset-0 bg-gradient-to-tr from-emerald-400/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
        </button>
        
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input value={targetId} onChange={e => setTargetId(e.target.value)} placeholder="输入好友房号..." className="flex-1 bg-slate-900 border border-white/10 rounded-2xl px-6 font-bold text-emerald-400 placeholder:text-slate-700 focus:border-emerald-500/50 focus:outline-none transition-all" />
            <button onClick={() => addLog("系统: 联机功能接入中...")} className="bg-slate-800 hover:bg-slate-700 px-6 py-4 rounded-2xl font-black chinese-font text-lg transition-all active:scale-90">加 入</button>
          </div>
          {myId && (
            <div className="mt-4 p-4 bg-slate-900/50 border border-emerald-500/20 rounded-2xl flex items-center justify-between group">
              <div className="flex flex-col">
                <span className="text-[10px] text-slate-500 font-black uppercase tracking-widest">我的房号</span>
                <span className="text-emerald-400 font-mono font-bold">{myId}</span>
              </div>
              <button onClick={handleShareRoom} className="p-2 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 rounded-xl transition-all flex items-center gap-1">
                📋 分享
              </button>
            </div>
          )}
        </div>
        
        <button onClick={() => setShowRules(true)} className="py-4 text-slate-500 font-black hover:text-emerald-400 transition-all uppercase tracking-widest text-xs">查看游戏规则</button>
      </div>
    </div>
  );

  const renderHistoryModal = () => (
    <div className="absolute inset-0 z-[1000] bg-black/80 backdrop-blur-md flex items-center justify-center p-6 animate-in fade-in duration-300">
      <div className="bg-slate-900 border border-emerald-500/30 p-8 rounded-[2rem] max-w-4xl w-full max-h-[80vh] flex flex-col shadow-2xl overflow-hidden">
        <h2 className="text-3xl font-black chinese-font text-emerald-500 mb-6 flex justify-between items-center shrink-0">
          <span>对局实录</span>
          <button onClick={() => setShowHistory(false)} className="text-slate-500 hover:text-white">✕</button>
        </h2>
        <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-4">
          {gameState.roundHistory.length === 0 ? (
            <div className="text-center py-20 text-slate-600 font-black chinese-font italic">尚无出牌记录</div>
          ) : (
            gameState.roundHistory.map((trick, tidx) => {
              const winner = [...trick].sort((a,b) => b.strength - a.strength)[0].playerId;
              return (
                <div key={tidx} className="p-4 bg-white/5 rounded-2xl border border-white/5 flex flex-col gap-3">
                  <div className="flex justify-between items-center border-b border-white/5 pb-2">
                    <span className="text-xs font-black text-slate-500 uppercase">第 {tidx + 1} 轮</span>
                    <span className="text-xs font-black text-emerald-500 chinese-font">赢家: {slots[winner].name}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    {trick.map((p, pidx) => (
                      <div key={pidx} className="flex flex-col items-center gap-2">
                        <span className="text-[10px] font-black text-slate-400">{slots[p.playerId].name}</span>
                        <div className="flex -space-x-4">
                          {p.cards.map(c => (
                            <PlayingCard key={c.id} card={c} size="mini" isBack={p.type === 'discard'} />
                          ))}
                        </div>
                      </div>
                    ))}
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
          <button onClick={() => setShowRules(false)} className="text-slate-500 hover:text-white">✕</button>
        </h2>
        <div className="space-y-6 text-slate-300 leading-relaxed font-medium">
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

  const renderTableSlot = (pid: PlayerId) => {
    const play = gameState.table.find(p => p.playerId === pid);
    if (!play) return <div className="w-20 h-32 md:w-24 md:h-36 rounded-2xl border-2 border-dashed border-white/5 flex items-center justify-center text-slate-800 text-[10px] uppercase font-black tracking-tighter">Wait...</div>;

    const isPlayer = pid === PlayerId.PLAYER;
    const animationClass = pid === PlayerId.PLAYER ? 'play-animation-bottom' : (pid === PlayerId.AI_LEFT ? 'play-animation-left' : 'play-animation-right');

    return (
      <div className={`flex transition-transform duration-500 ${isPlayer ? 'translate-y-12' : ''} ${animationClass}`}>
        {play.cards.map((c, i) => (
          <div 
            key={c.id} 
            style={{ 
              marginLeft: i === 0 ? 0 : '-1.5rem', 
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
    const isMyTurn = gameState.betTurn === PlayerId.PLAYER;
    
    return (
      <div className="absolute inset-0 z-[400] bg-slate-950/60 backdrop-blur-sm flex flex-col items-center justify-center p-6 animate-in zoom-in">
        <div className="bg-slate-900 border border-emerald-500/40 p-10 rounded-[3rem] shadow-2xl text-center max-w-md w-full relative">
          <div className="absolute top-[-40px] landscape:top-[-20px] left-1/2 -translate-x-1/2 bg-emerald-500 text-slate-950 font-black px-6 py-2 rounded-full shadow-xl">
            {isMyTurn ? "轮到您决策" : `等待 ${slots[gameState.betTurn!].name} 决策...`}
          </div>
          
          <div className="mb-6">
            <div className="text-slate-400 text-xs uppercase tracking-widest mb-2">当前倍率</div>
            <div className="flex justify-center gap-4">
               <div className="bg-black/40 px-4 py-2 rounded-xl border border-white/5">
                 <span className="text-[10px] text-slate-500 block">全局抢牌</span>
                 <span className="text-xl font-black text-emerald-400">x{gameState.grabMultiplier}</span>
               </div>
               {gameState.grabber && (
                 <div className="bg-red-600/20 px-4 py-2 rounded-xl border border-red-500/30">
                   <span className="text-[10px] text-red-400 block">抢牌者</span>
                   <span className="text-sm font-black text-white">{slots[gameState.grabber].name}</span>
                 </div>
               )}
            </div>
          </div>

          {isMyTurn ? (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-3 gap-3">
                <button onClick={() => processBet(PlayerId.PLAYER, 1, false)} className="py-4 bg-slate-800 hover:bg-slate-700 rounded-2xl font-black text-sm transition-all border border-white/5">不加倍</button>
                <button onClick={() => processBet(PlayerId.PLAYER, 2, false)} className="py-4 bg-emerald-600/20 text-emerald-400 border border-emerald-500/20 rounded-2xl font-black text-sm hover:bg-emerald-600/30 transition-all">加倍 x2</button>
                <button onClick={() => processBet(PlayerId.PLAYER, 4, false)} className="py-4 bg-orange-600/20 text-orange-400 border border-orange-500/20 rounded-2xl font-black text-sm hover:bg-orange-600/30 transition-all">超倍 x4</button>
              </div>
              <button 
                onClick={() => processBet(PlayerId.PLAYER, gameState.multipliers[PlayerId.PLAYER], true)} 
                className={`py-4 rounded-2xl font-black chinese-font transition-all text-lg bg-red-600 hover:bg-red-500 shadow-xl text-white`}
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
    if (gameState.turn !== PlayerId.PLAYER || gameState.phase !== GamePhase.PLAYING) return false;
    if (!targetPlay) return selectedStrength.type !== 'discard';
    return selectedStrength.type === targetPlay.type && 
           selectedCards.length === targetPlay.cards.length && 
           selectedStrength.strength > currentMaxStr;
  }, [gameState.turn, gameState.phase, targetPlay, selectedStrength, selectedCards.length, currentMaxStr]);

  const mustFollowIfPossible = useMemo(() => {
    if (gameState.turn !== PlayerId.PLAYER || !targetPlay || gameState.phase !== GamePhase.PLAYING) return false;
    const validPlays = getValidPlays(gameState.hands[PlayerId.PLAYER], targetPlay, currentMaxStr);
    return validPlays.length > 0;
  }, [gameState.turn, targetPlay, gameState.phase, gameState.hands, currentMaxStr]);

  const canDiscard = useMemo(() => {
    if (gameState.turn !== PlayerId.PLAYER || !targetPlay || gameState.phase !== GamePhase.PLAYING) return false;
    return selectedCards.length === targetPlay.cards.length && !mustFollowIfPossible;
  }, [gameState.turn, targetPlay, selectedCards.length, mustFollowIfPossible, gameState.phase]);

  const canInitiateKouLe = useMemo(() => {
    return gameState.phase === GamePhase.PLAYING && 
           gameState.turn === PlayerId.PLAYER && 
           gameState.table.length === 0 && 
           gameState.kouLeInitiator === null;
  }, [gameState.phase, gameState.turn, gameState.table.length, gameState.kouLeInitiator]);

  return (
    <div className="h-screen w-full flex flex-col bg-slate-950 text-slate-100 overflow-hidden relative landscape:flex-row">
      {gameState.phase === GamePhase.LOBBY && renderLobby()}
      {showRules && renderRulesModal()}
      {showHistory && renderHistoryModal()}
      
      {gameState.phase === GamePhase.WAITING && (
         <div className="absolute inset-0 z-[400] bg-slate-950/95 backdrop-blur-2xl flex flex-col items-center justify-center p-6">
            <div className="flex flex-col items-center gap-2 mb-10">
               <h2 className="text-2xl font-black chinese-font text-emerald-500">等待备战中...</h2>
               {isHost && (
                  <button onClick={handleShareRoom} className="px-4 py-1.5 bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 rounded-full text-[10px] font-black hover:bg-emerald-600/30 transition-all flex items-center gap-2">🔗 复制房间邀请链接</button>
               )}
            </div>
            <div className="flex items-center justify-center gap-8 md:gap-24 mb-16">
              {[PlayerId.AI_LEFT, PlayerId.PLAYER, PlayerId.AI_RIGHT].map(id => (
                <div key={id} className={`flex flex-col items-center gap-4 ${id === PlayerId.PLAYER ? 'mt-20' : ''}`}>
                   <div className={`w-20 h-20 md:w-28 md:h-28 rounded-full border-2 flex items-center justify-center text-4xl shadow-2xl transition-all ${id === PlayerId.PLAYER ? 'border-emerald-500 bg-slate-800' : (slots[id].type === 'empty' ? 'border-dashed border-slate-700 bg-slate-900/50 grayscale' : 'border-emerald-500 bg-slate-800')}`}>
                      {id === PlayerId.PLAYER ? '👤' : (slots[id].type === 'empty' ? '?' : (slots[id].type === 'ai' ? '🤖' : '侠'))}
                   </div>
                   <div className="text-center">
                      <div className="text-xs font-black text-slate-300 chinese-font">{slots[id].name}</div>
                      <div className="flex items-center justify-center gap-1 text-[10px] font-bold text-yellow-500 mt-1">
                        🪙 {gameState.starCoins[id]}
                      </div>
                      {isHost && id !== PlayerId.PLAYER && slots[id].type !== 'human' && (
                        <button onClick={() => setSlots(prev => { 
                          const n = {...prev}; 
                          if(n[id].type === 'empty') { 
                            const usedNames = Object.values(slots).map((s: SlotInfo) => s.name);
                            const name = AI_NAME_POOL.filter(n => !usedNames.includes(n))[0] || 'AI'; 
                            n[id] = { type: 'ai', name }; 
                            setGameState(gs => ({...gs, aiNames: {...gs.aiNames, [id]: name}})); 
                          } else { 
                            n[id] = { type: 'empty', name: '等待加入...' }; 
                            setGameState(gs => ({...gs, aiNames: {...gs.aiNames, [id]: 'AI'}})); 
                          } 
                          return n; 
                        })} className="mt-2 text-[10px] text-emerald-500 hover:underline">{slots[id].type === 'empty' ? '+ 添加 AI' : '× 移除 AI'}</button>
                      )}
                   </div>
                </div>
              ))}
            </div>
            {isHost ? (
               <div className="flex flex-col gap-4 w-full max-sm pb-16 landscape:pb-20">
                  <button onClick={() => initGame()} disabled={slots[PlayerId.AI_LEFT].type === 'empty' || slots[PlayerId.AI_RIGHT].type === 'empty'} className={`px-20 py-6 rounded-3xl font-black text-2xl transition-all chinese-font shadow-2xl ${slots[PlayerId.AI_LEFT].type !== 'empty' && slots[PlayerId.AI_RIGHT].type !== 'empty' ? 'bg-emerald-600 hover:scale-105 active:scale-95' : 'bg-slate-800 text-slate-600 opacity-50 cursor-not-allowed'}`}>开 始 游 戏</button>
                  <button onClick={quitToLobby} className="py-3 text-slate-500 text-xs font-black hover:text-slate-300 transition-all uppercase tracking-widest">解散房间并返回</button>
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

      <div className="flex-1 flex flex-col h-full relative">
        <div className="h-14 flex justify-between items-center px-4 bg-slate-900/80 backdrop-blur-md border-b border-white/5 z-50">
          <div className="flex items-center gap-4 shrink-0"><div className="flex flex-col"><span className="text-xl font-black text-emerald-500 chinese-font">宣坨坨</span><span className="text-[8px] opacity-40 uppercase tracking-widest leading-none">NETWORK V2.0</span></div></div>
          <div className="flex-1 flex justify-center items-center px-4 overflow-hidden gap-2">
            {gameState.grabber === PlayerId.PLAYER && (
              <div className="bg-red-600 px-3 py-1 rounded-full shadow-lg animate-pulse shrink-0 border border-red-400/30">
                <span className="text-[10px] md:text-xs font-black text-white whitespace-nowrap">🎴 已抢收 x{gameState.grabMultiplier}</span>
              </div>
            )}
            {(gameState.challengers[PlayerId.PLAYER] || 0) > 0 && (
              <div className="bg-orange-600 px-3 py-1 rounded-full shadow-lg shrink-0 border border-orange-400/30">
                <span className="text-[10px] md:text-xs font-black text-white whitespace-nowrap">🔥 已应战 x{gameState.challengers[PlayerId.PLAYER]}</span>
              </div>
            )}
            <div key={gameState.logs[0]} className="bg-slate-950/40 px-6 py-1.5 rounded-full border border-emerald-500/20 animate-in zoom-in slide-in-from-top-2 duration-300">
               <span className="text-xs md:text-sm font-black text-emerald-400 chinese-font truncate block max-w-[150px] md:max-w-md">{gameState.logs[0] || '对局进行中...'}</span>
            </div>
          </div>
          <div className="text-xs font-mono bg-black/60 px-3 py-1.5 rounded-lg border border-white/10 flex items-center gap-2 shrink-0"><span className="text-yellow-500 text-base">🪙</span><span className="font-bold text-yellow-100">{gameState.starCoins[PlayerId.PLAYER]}</span></div>
        </div>

        <div className="flex-1 relative flex items-center justify-center landscape:pb-12">
          {[PlayerId.AI_LEFT, PlayerId.AI_RIGHT].map(id => (
            <div key={id} className={`absolute top-6 ${id === PlayerId.AI_LEFT ? 'left-6' : 'right-6'} flex flex-col items-center gap-2 z-30`}>
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
                  <div className="absolute -bottom-2 -right-2 bg-yellow-500 text-black font-black text-[10px] px-1.5 py-0.5 rounded-md shadow-sm border border-slate-900 z-20">
                    x{gameState.multipliers[id]}
                  </div>
                )}
                
                {/* 抢收牌状态 - 左下角 */}
                {gameState.grabber === id && (
                  <div className="absolute -bottom-2 -left-2 bg-red-600 text-white text-[8px] px-1.5 py-0.5 rounded-md font-black shadow-lg animate-pulse whitespace-nowrap z-20 border border-white/20">
                    抢收
                  </div>
                )}
              </div>
              <div className="flex flex-col items-center gap-0.5 text-center">
                <span className="text-[10px] md:text-[11px] font-black text-slate-300 chinese-font">{slots[id].name} ({gameState.hands[id].length})</span>
                <div className="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full text-[8px] md:text-[9px] font-black">已收: {(gameState.collected[id] as Card[]).length}</div>
              </div>
            </div>
          ))}
          <div className="flex items-center justify-center gap-8 md:gap-24 z-20 w-full max-w-5xl px-10 scale-90 md:scale-100">{renderTableSlot(PlayerId.AI_LEFT)}{renderTableSlot(PlayerId.PLAYER)}{renderTableSlot(PlayerId.AI_RIGHT)}</div>
          
          {gameState.phase === GamePhase.KOU_LE_DECISION && (
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-[150] flex items-center justify-center p-6 animate-in fade-in">
              <div className="bg-slate-900 border border-emerald-500/40 p-8 rounded-3xl max-w-sm w-full text-center shadow-2xl">
                <div className="text-3xl mb-4">⚖️</div>
                <h3 className="text-xl font-black text-emerald-500 chinese-font mb-2">“扣了”博弈中</h3>
                {(() => {
                  const initiator = gameState.kouLeInitiator;
                  const respondents = getNextRespondents(initiator!);
                  const currentDecider = respondents.find(id => gameState.kouLeResponses[id] === null);
                  const initiatorName = initiator === PlayerId.PLAYER ? '您' : slots[initiator!].name;
                  const deciderName = currentDecider === PlayerId.PLAYER ? '我' : (currentDecider ? slots[currentDecider].name : '...');
                  
                  return (
                    <>
                      <p className="text-sm text-slate-400 mb-6">{initiatorName} 发起博弈，当前 {deciderName} 表态...</p>
                      {currentDecider === PlayerId.PLAYER ? (
                        <div className="flex gap-4 animate-in slide-in-from-bottom duration-500">
                          <button onClick={() => processKouLeResponse(PlayerId.PLAYER, 'agree')} className="flex-1 py-4 bg-slate-800 hover:bg-slate-700 rounded-xl font-black transition-all">扣了(同意)</button>
                          <button onClick={() => processKouLeResponse(PlayerId.PLAYER, 'challenge')} className="flex-1 py-4 bg-orange-600 hover:bg-orange-500 rounded-xl font-black transition-all">宣(挑战)</button>
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
        </div>

        <div className="h-44 md:h-64 bg-slate-900/95 border-t border-white/5 p-4 flex flex-col items-center justify-end relative z-40">
           <div className="absolute left-6 top-[-25px] px-4 py-1.5 bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-xl text-[10px] font-black md:hidden shadow-lg backdrop-blur-md">已收: {(gameState.collected[PlayerId.PLAYER] as Card[]).length}</div>
           <div className="absolute left-1/2 -translate-x-1/2 top-[-25px] flex gap-2">
             <div className="px-3 py-1 bg-black/40 border border-white/10 rounded-lg text-[10px] font-black text-yellow-500 shadow-md">我的加倍: x{gameState.multipliers[PlayerId.PLAYER]}</div>
             <div className="px-3 py-1 bg-red-600/40 border border-white/10 rounded-lg text-[10px] font-black text-white shadow-md">全局倍率: x{gameState.grabMultiplier}</div>
           </div>
           <div className="flex gap-2 justify-center pb-4 px-10 overflow-visible max-w-7xl w-full">
             {playerHandSorted.map((c, i) => { 
                const isSel = selectedCards.some(sc => sc.id === c.id);
                const isHovered = hoveredCardId === c.id;
                const isActive = isSel || isHovered;
                return (
                  <div key={c.id} onMouseEnter={() => setHoveredCardId(c.id)} onMouseLeave={() => setHoveredCardId(null)} onClick={() => setSelectedCards(prev => isSel ? prev.filter(sc => sc.id !== c.id) : [...prev, c])} className={`transition-all duration-300 cursor-pointer relative ${isActive ? '-translate-y-12 scale-110' : ''}`} style={{ marginLeft: i === 0 ? 0 : '-2.5rem', zIndex: i }}>
                    <div className={isActive ? 'drop-shadow-[0_0_25px_rgba(16,185,129,0.8)]' : 'drop-shadow-lg'}><PlayingCard card={c} /></div>
                  </div>
                ); 
             })}
           </div>
        </div>
      </div>
      
      <div className="w-16 md:w-24 landscape:h-screen bg-slate-900/90 border-l border-white/10 flex flex-col items-center justify-center p-3 gap-5 md:gap-7 z-[100] backdrop-blur-lg shadow-2xl">
        <button onClick={() => handleAction(false)} disabled={!canFollow} className={`w-12 h-12 md:w-16 md:h-16 flex items-center justify-center rounded-2xl font-black transition-all text-xl md:text-3xl border border-white/10 ${canFollow ? 'bg-emerald-600 hover:bg-emerald-500 active:scale-90 shadow-[0_0_25px_rgba(16,185,129,0.3)] text-white' : 'bg-slate-800/50 text-slate-700 opacity-40 cursor-not-allowed'}`}>{gameState.table.length === 0 ? '出' : '跟'}</button>
        <button onClick={() => handleAction(true)} disabled={!canDiscard} className={`w-12 h-12 md:w-16 md:h-16 flex items-center justify-center rounded-2xl font-black transition-all text-xl md:text-3xl border border-white/10 ${canDiscard ? 'bg-orange-700 hover:bg-orange-600 active:scale-90 shadow-[0_0_25px_rgba(194,65,12,0.3)] text-white' : 'bg-slate-800/50 text-slate-700 opacity-40 cursor-not-allowed'}`}>扣</button>
        <div className="h-px w-8 bg-white/10"></div>
        <button onClick={handleHint} disabled={gameState.phase !== GamePhase.PLAYING || gameState.turn !== PlayerId.PLAYER} className={`w-12 h-12 md:w-16 md:h-16 flex items-center justify-center rounded-2xl font-black transition-all text-xl md:text-3xl border border-white/10 ${gameState.turn === PlayerId.PLAYER && gameState.phase === GamePhase.PLAYING ? 'bg-indigo-600 hover:bg-indigo-500 active:scale-90 shadow-[0_0_25px_rgba(79,70,229,0.3)] text-white' : 'bg-slate-800/50 text-slate-700 opacity-40 cursor-not-allowed'}`}>提</button>
        <button onClick={() => setShowRules(true)} className="w-10 h-10 md:w-14 md:h-14 flex items-center justify-center bg-slate-800 hover:bg-slate-700 rounded-xl text-lg md:text-xl font-black text-slate-400 active:scale-90 transition-all border border-white/5">规</button>
        <button onClick={() => setShowHistory(true)} className="w-10 h-10 md:w-14 md:h-14 flex items-center justify-center bg-slate-800 hover:bg-slate-700 rounded-xl border border-white/5 font-black text-lg md:text-xl chinese-font transition-all active:scale-90 text-slate-300">录</button>
        {canInitiateKouLe && (
          <button onClick={() => processInitiateKouLe(PlayerId.PLAYER)} className="w-10 h-10 md:w-14 md:h-14 flex items-center justify-center bg-red-600 hover:bg-red-500 rounded-xl border border-red-400 font-black text-xs md:text-sm transition-all active:scale-90 text-white shadow-lg animate-pulse">扣了</button>
        )}
      </div>

      {gameState.phase === GamePhase.SETTLEMENT && (
        <div className="absolute inset-0 z-[300] bg-slate-950/98 flex items-center justify-center p-4 backdrop-blur-3xl animate-in zoom-in overflow-hidden">
          <div className="max-w-md w-full max-h-[90vh] flex flex-col bg-slate-900 border border-emerald-500/40 p-5 md:p-10 rounded-[30px] md:rounded-[40px] shadow-2xl text-center overflow-hidden">
            <h2 className="text-xl md:text-4xl font-black chinese-font text-emerald-500 mb-4 md:mb-6 tracking-widest shrink-0">对局结算</h2>
            <div className="flex-1 overflow-y-auto space-y-3 md:space-y-4 mb-4 md:mb-8 pr-2 custom-scrollbar">
              {settlementData.map(res => (
                <div key={res.id} className={`flex justify-between items-center p-4 bg-white/5 rounded-2xl border transition-all ${res.netGain < 0 ? 'border-red-500/30 opacity-70' : (res.netGain > 0 ? 'border-emerald-500/50 scale-105 shadow-[0_0_20px_rgba(16,185,129,0.1)]' : 'border-white/5')}`}>
                  <div className="flex flex-col items-start">
                    <span className="font-black text-sm md:text-lg chinese-font">{slots[res.id].name}</span>
                    <span className="text-[10px] text-yellow-500 font-bold uppercase">总倍率: x{res.finalMultiplier}</span>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className={`font-black px-2 md:px-3 py-0.5 md:py-1 rounded-lg text-[10px] md:text-sm ${res.coins > 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>{res.level} ({res.cards}张)</span>
                    <span className={`text-xs md:text-base font-black mt-1 ${res.netGain > 0 ? 'text-yellow-500' : (res.netGain < 0 ? 'text-red-500' : 'text-slate-400')}`}>{res.netGain > 0 ? `+${res.netGain}` : res.netGain} 🪙</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="shrink-0 space-y-2 md:space-y-3">
              {isHost && (<button onClick={() => {setGameState(prev => ({...prev, phase: GamePhase.WAITING})); broadcast('SYNC_STATE', {...gameState, phase: GamePhase.WAITING});}} className="w-full py-3 md:py-5 bg-emerald-600 hover:bg-emerald-500 rounded-2xl font-black text-base md:text-xl shadow-2xl transition-all chinese-font active:scale-95">整 顿 再 战</button>)}
              <button onClick={quitToLobby} className="w-full py-2 md:py-3 bg-slate-800 text-slate-400 rounded-xl text-[10px] md:text-xs font-black transition-all hover:bg-slate-700">返回大厅</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;