
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
  aiDecidePlay, aiEvaluateKouLe,
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
  play(type: 'deal' | 'play' | 'win' | 'settle' | 'victory' | 'defeat' | 'shuffle') {
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
      case 'victory': [523.25, 659.25, 783.99, 1046.50].forEach((f, i) => playTone(f, now + i * 0.15, 0.4, 0.1, 'triangle')); break;
      case 'defeat': [349.23, 293.66, 261.63, 196.00].forEach((f, i) => playTone(f, now + i * 0.2, 0.6, 0.1, 'sawtooth')); break;
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
  logs: ['系统: 宣坨坨联机大厅已就绪。'],
  aiNames: { [PlayerId.AI_LEFT]: 'AI 左', [PlayerId.AI_RIGHT]: 'AI 右' },
  roundHistory: [],
  nextStarter: null
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
  const logContainerRef = useRef<HTMLDivElement>(null);

  const playerHandSorted = useMemo(() => {
    return [...gameState.hands[PlayerId.PLAYER]].sort((a, b) => a.strength - b.strength);
  }, [gameState.hands]);

  const addLog = useCallback((msg: string) => {
    setGameState(prev => ({ ...prev, logs: [msg, ...prev.logs].slice(0, 30) }));
  }, []);

  const settlementData = useMemo(() => {
    const players = [PlayerId.PLAYER, PlayerId.AI_LEFT, PlayerId.AI_RIGHT];
    const stats = players.map(pid => {
      const count = gameState.collected[pid].length;
      return { id: pid, cards: count, ...getRewardInfo(count) };
    });
    const winners = stats.filter(s => s.coins > 0);
    const losers = stats.filter(s => s.coins === 0);
    const results = stats.map(s => ({ ...s, netGain: 0, multiplier: 0 }));

    results.forEach(res => {
      const currentStat = stats.find(s => s.id === res.id)!;
      if (currentStat.coins > 0) res.netGain = currentStat.coins * losers.length;
      else res.netGain = -(winners.reduce((sum, w) => sum + w.coins, 0));
    });

    if (gameState.kouLeInitiator) {
      const initiatorStat = stats.find(s => s.id === gameState.kouLeInitiator)!;
      const initiatorRes = results.find(r => r.id === gameState.kouLeInitiator)!;
      
      if (initiatorStat.coins > 0) {
        Object.entries(gameState.challengers).forEach(([chalId, chalCount]) => {
          if (chalCount > 0) {
            const chalStat = stats.find(s => s.id === chalId)!;
            const chalRes = results.find(r => r.id === chalId)!;
            if (chalStat.coins === 0) {
              const riskAmount = initiatorStat.coins * 2 * chalCount; 
              chalRes.netGain -= riskAmount;
              chalRes.multiplier = chalCount * 2;
              initiatorRes.netGain += riskAmount;
            }
          }
        });
      }
    }
    return results;
  }, [gameState.collected, gameState.kouLeInitiator, gameState.challengers, gameState.aiNames]);

  useEffect(() => {
    if (gameState.phase === GamePhase.SETTLEMENT) {
      const myRes = settlementData.find(r => r.id === PlayerId.PLAYER);
      if (myRes) {
        if (myRes.netGain > 0) SoundEngine.play('victory');
        else if (myRes.netGain < 0) SoundEngine.play('defeat');
        else SoundEngine.play('settle');
      }
    }
  }, [gameState.phase, settlementData]);

  useEffect(() => {
    if (logContainerRef.current) logContainerRef.current.scrollTop = 0;
  }, [gameState.logs]);

  const broadcast = useCallback((type: string, payload: any) => {
    Object.values(connectionsRef.current).forEach((conn: any) => {
      if (conn.open) conn.send({ type, payload, senderId: peerRef.current?.id });
    });
  }, []);

  const sendToHost = useCallback((type: string, payload: any) => {
    if (isHost) return;
    const hostConn = Object.values(connectionsRef.current)[0];
    if (hostConn && hostConn.open) hostConn.send({ type, payload, senderId: peerRef.current?.id });
  }, [isHost]);

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
          ...prev, phase: GamePhase.PLAYING, hands,
          collected: { [PlayerId.PLAYER]: [], [PlayerId.AI_LEFT]: [], [PlayerId.AI_RIGHT]: [] },
          table: [], turn: starter, starter: starter, roundHistory: [],
          kouLeInitiator: null, 
          challengers: { [PlayerId.PLAYER]: 0, [PlayerId.AI_LEFT]: 0, [PlayerId.AI_RIGHT]: 0 },
          kouLeResponses: { [PlayerId.PLAYER]: null, [PlayerId.AI_LEFT]: null, [PlayerId.AI_RIGHT]: null },
          logs: [`🎴 发牌完成！${starter === PlayerId.PLAYER ? '您' : prev.aiNames[starter]} 先出牌。`, ...prev.logs].slice(0, 30),
          nextStarter: null
        };
        broadcast('SYNC_STATE', newState);
        return newState;
      });
      SoundEngine.play('deal');
    }, 2000);
  }, [isHost, broadcast, addLog]);

  const getNextRespondents = (initiator: PlayerId): PlayerId[] => {
    const order = [PlayerId.PLAYER, PlayerId.AI_RIGHT, PlayerId.AI_LEFT];
    const idx = order.indexOf(initiator);
    return [order[(idx + 1) % 3], order[(idx + 2) % 3]];
  };

  const processKouLeResponse = useCallback((pid: PlayerId, resp: 'agree' | 'challenge') => {
    setGameState(prev => {
      const newRes = { ...prev.kouLeResponses, [pid]: resp };
      const newLogs = [...prev.logs];
      const pName = pid === PlayerId.PLAYER ? '您' : prev.aiNames[pid];
      
      const respondents = getNextRespondents(prev.kouLeInitiator!);
      let nextPhase = GamePhase.KOU_LE_DECISION;
      let newChallengers = { ...prev.challengers };

      if (resp === 'challenge') {
        const currentCount = newChallengers[pid] + 1;
        newLogs.unshift(`🔥 宣战: 【${pName}】 选择了“宣”(应战)！当前倍率: ${currentCount * 2}x。另一方无需决策。`);
        newChallengers[pid] = currentCount;
        nextPhase = GamePhase.PLAYING; 
      } else {
        newLogs.unshift(`✓ 响应: ${pName} 选择了“扣了”`);
        if (newRes[respondents[1]] !== null) {
          newLogs.unshift("🤝 结果: 达成共识(均扣了)，正在重新洗牌...");
          nextPhase = GamePhase.SETTLEMENT;
          SoundEngine.play('settle');
        } else {
          newLogs.unshift(`⏳ 等待: 请 ${prev.aiNames[respondents[1]] || '您'} 做出决策...`);
        }
      }
      
      const nextS = { ...prev, phase: nextPhase, kouLeResponses: newRes, challengers: newChallengers, logs: newLogs.slice(0, 30) };
      if (isHost) broadcast('SYNC_STATE', nextS);
      return nextS;
    });
  }, [isHost, broadcast]);

  const processPlayCards = useCallback((playerId: PlayerId, cards: Card[], isDiscard: boolean = false) => {
    setGameState(prev => {
      const { strength, type } = calculatePlayStrength(cards);
      const newTable = [...prev.table, { playerId, cards, type: isDiscard ? 'discard' : type, strength: isDiscard ? -1 : strength }];
      const nextS = {
        ...prev, hands: { ...prev.hands, [playerId]: prev.hands[playerId].filter(c => !cards.some(sc => sc.id === c.id)) },
        table: newTable, turn: (playerId === PlayerId.AI_LEFT ? PlayerId.PLAYER : (playerId === PlayerId.PLAYER ? PlayerId.AI_RIGHT : PlayerId.AI_LEFT)) as PlayerId
      };
      if (newTable.length === 3) setTimeout(resolveRound, 800);
      if (isHost) broadcast('SYNC_STATE', nextS);
      return nextS;
    });
    SoundEngine.play('play');
  }, [isHost, broadcast]);

  const resolveRound = useCallback(() => {
    if (!isHost) return;
    setGameState(prev => {
      let winnerId = prev.table[0].playerId;
      let maxStr = prev.table[0].strength;
      prev.table.forEach(p => { if (p.strength > maxStr) { maxStr = p.strength; winnerId = p.playerId; } });
      const cardsOnTable = prev.table.reduce((acc: Card[], p) => acc.concat(p.cards), []);
      const nextS = {
        ...prev, phase: GamePhase.ROUND_OVER, roundHistory: [...prev.roundHistory, prev.table],
        collected: { ...prev.collected, [winnerId]: [...prev.collected[winnerId], ...cardsOnTable] },
        logs: [`🏆 ${winnerId === PlayerId.PLAYER ? '您' : prev.aiNames[winnerId]} 赢了此轮！`, ...prev.logs].slice(0, 30),
        nextStarter: winnerId
      };
      broadcast('SYNC_STATE', nextS);
      return nextS;
    });
    setTimeout(() => {
      setGameState(prev => {
        const gameOver = Object.values(prev.hands).some(h => h.length === 0);
        const nextS: GameState = gameOver ? { ...prev, phase: GamePhase.SETTLEMENT } : { ...prev, phase: GamePhase.PLAYING, table: [], turn: prev.nextStarter!, starter: prev.nextStarter!, nextStarter: null };
        broadcast('SYNC_STATE', nextS);
        return nextS;
      });
    }, 1500);
  }, [isHost, broadcast]);

  const handleNetworkMessage = useCallback((msg: NetworkMessage) => {
    switch (msg.type) {
      case 'SYNC_STATE': setGameState(msg.payload); break;
      case 'ACTION_PLAY': if (isHost) processPlayCards(msg.payload.playerId, msg.payload.cards, msg.payload.isDiscard); break;
      case 'ACTION_KOU_LE_INIT': if (isHost) processInitiateKouLe(msg.payload.playerId); break;
      case 'ACTION_KOU_LE_RES': if (isHost) processKouLeResponse(msg.payload.playerId, msg.payload.response); break;
    }
  }, [isHost, processKouLeResponse, processPlayCards]);

  const initPeer = useCallback(() => {
    if (peerRef.current) return;
    const peer = new Peer();
    peerRef.current = peer;
    peer.on('open', (id: string) => {
      setMyId(id);
      // 检查 URL 是否有 room 参数
      const params = new URLSearchParams(window.location.search);
      const roomId = params.get('room');
      if (roomId && roomId !== id) {
        setTargetId(roomId);
        // 延迟连接以确保 Peer 已就绪
        setTimeout(() => {
          const conn = peer.connect(roomId);
          conn.on('open', () => {
            connectionsRef.current[conn.peer] = conn;
            setConnectedPeers([conn.peer]);
            addLog(`已通过链接自动加入房间 ${roomId.slice(0,4)}。`);
            setGameState(prev => ({ ...prev, phase: GamePhase.WAITING }));
          });
          conn.on('data', (data: NetworkMessage) => handleNetworkMessage(data));
          conn.on('error', (err: any) => {
             addLog("⚠️ 无法连接到房间。可能房主已退出或房间已满。");
             window.history.replaceState({}, document.title, window.location.pathname);
          });
        }, 1000);
      }
    });

    peer.on('connection', (conn: any) => {
      // 检查房间是否已满 (3人限制)
      const currentHumanCount = Object.values(slots).filter(s => s.type === 'human').length;
      if (currentHumanCount >= 3) {
        conn.on('open', () => {
          conn.send({ type: 'ERROR', payload: '房间已满 (最多3人)' });
          setTimeout(() => conn.close(), 1000);
        });
        return;
      }

      setIsHost(true);
      conn.on('open', () => {
        connectionsRef.current[conn.peer] = conn;
        setConnectedPeers(prev => [...prev, conn.peer]);
        
        setSlots(prev => {
          const next = { ...prev };
          let assignedPlayerId: PlayerId | null = null;
          if (next[PlayerId.AI_LEFT].type !== 'human') assignedPlayerId = PlayerId.AI_LEFT;
          else if (next[PlayerId.AI_RIGHT].type !== 'human') assignedPlayerId = PlayerId.AI_RIGHT;
          
          if (assignedPlayerId) {
            // 挑选一个未使用的中文昵称
            const usedNames = Object.values(next).map(s => s.name);
            const availableNames = AI_NAME_POOL.filter(n => !usedNames.includes(n));
            const randomName = availableNames[Math.floor(Math.random() * availableNames.length)] || `侠客 ${conn.peer.slice(0,2)}`;
            
            next[assignedPlayerId] = { type: 'human', peerId: conn.peer, name: randomName };
            setGameState(gs => {
              const updated = { ...gs, aiNames: { ...gs.aiNames, [assignedPlayerId!]: randomName } };
              setTimeout(() => broadcast('SYNC_STATE', updated), 500);
              return updated;
            });
          }
          return { ...next };
        });
        addLog(`系统: 新玩家已加入。`);
      });
      conn.on('data', (data: NetworkMessage) => handleNetworkMessage(data));
      conn.on('close', () => { 
        delete connectionsRef.current[conn.peer]; 
        setConnectedPeers(prev => prev.filter(p => p !== conn.peer)); 
        setSlots(prev => {
          const n = {...prev};
          const sid = Object.keys(n).find(k => (n as any)[k].peerId === conn.peer) as PlayerId;
          if(sid) n[sid] = { type: 'empty', name: '等待加入...' };
          return n;
        });
      });
    });
  }, [handleNetworkMessage, broadcast, addLog, slots]);

  useEffect(() => {
    initPeer();
    return () => { if (peerRef.current) peerRef.current.destroy(); };
  }, [initPeer]);

  const joinRoom = () => {
    if (!targetId || targetId === myId) return;
    const conn = peerRef.current.connect(targetId);
    conn.on('open', () => { 
      connectionsRef.current[conn.peer] = conn; 
      setConnectedPeers([conn.peer]); 
      addLog(`已成功连接房主 ${targetId.slice(0,4)}。`); 
      setGameState(prev => ({ ...prev, phase: GamePhase.WAITING })); 
      // 更新 URL 方便刷新
      window.history.replaceState({}, document.title, `?room=${targetId}`);
    });
    conn.on('data', (data: NetworkMessage) => handleNetworkMessage(data));
  };

  const processInitiateKouLe = (pid: PlayerId) => {
    setGameState(prev => {
      const respondents = getNextRespondents(pid);
      const nextS: GameState = {
        ...prev, phase: GamePhase.KOU_LE_DECISION, kouLeInitiator: pid,
        kouLeResponses: { [PlayerId.PLAYER]: null, [PlayerId.AI_LEFT]: null, [PlayerId.AI_RIGHT]: null, [pid]: 'agree' },
        logs: [`⚖️ 博弈: ${pid === PlayerId.PLAYER ? '您' : prev.aiNames[pid]} 发起了“扣了”！请 ${prev.aiNames[respondents[0]] || '您'} 表态。`, ...prev.logs].slice(0, 30),
      };
      if (isHost) broadcast('SYNC_STATE', nextS);
      return nextS;
    });
  };

  useEffect(() => {
    if (isHost && gameState.phase === GamePhase.PLAYING && gameState.turn !== PlayerId.PLAYER) {
      const currentSlot = slots[gameState.turn];
      if (currentSlot && currentSlot.type === 'ai') {
        const timeout = setTimeout(() => {
          const targetPlay = gameState.table.length > 0 ? gameState.table[0] : null;
          const currentMaxStr = gameState.table.length > 0 ? Math.max(...gameState.table.map(p => p.strength)) : -1;
          const aiHand = gameState.hands[gameState.turn];
          const collectedCount = gameState.collected[gameState.turn].length;
          const play = aiDecidePlay(aiHand, targetPlay, currentMaxStr, collectedCount);
          const { type: playType } = calculatePlayStrength(play);
          const isDiscard = targetPlay ? (playType === 'discard' || play.length !== targetPlay.cards.length || calculatePlayStrength(play).strength <= currentMaxStr) : false;
          processPlayCards(gameState.turn, play, isDiscard);
        }, 1500);
        return () => clearTimeout(timeout);
      }
    }
  }, [isHost, gameState.phase, gameState.turn, gameState.table, gameState.hands, gameState.collected, slots, processPlayCards]);

  useEffect(() => {
    if (isHost && gameState.phase === GamePhase.KOU_LE_DECISION) {
      const respondents = getNextRespondents(gameState.kouLeInitiator!);
      const currentDecider = respondents.find(id => gameState.kouLeResponses[id] === null);
      
      if (currentDecider && slots[currentDecider].type === 'ai') {
        const timer = setTimeout(() => {
          const resp = aiEvaluateKouLe(gameState.hands[currentDecider], gameState.collected[currentDecider].length);
          processKouLeResponse(currentDecider, resp);
        }, 1500);
        return () => clearTimeout(timer);
      }
    }
  }, [isHost, gameState.phase, gameState.kouLeResponses, gameState.kouLeInitiator, slots, gameState.hands, gameState.collected, processKouLeResponse]);

  const handleAction = (isDiscard: boolean) => {
    const currentMaxStr = gameState.table.length > 0 ? Math.max(...gameState.table.map(p => p.strength)) : -1;
    const targetPlay = gameState.table.length > 0 ? gameState.table[0] : null;
    if (isDiscard) {
      if (getValidPlays(gameState.hands[PlayerId.PLAYER], targetPlay, currentMaxStr).length > 0) { addLog("⚠️ 提示: 您有能管上的牌，必须出牌！"); return; }
      if (selectedCards.length !== (targetPlay?.cards.length || 0)) { addLog(`需扣除 ${targetPlay?.cards.length} 张牌。`); return; }
    } else {
      const playInfo = calculatePlayStrength(selectedCards);
      if (targetPlay) {
        if (selectedCards.length !== targetPlay.cards.length) { addLog(`需出 ${targetPlay.cards.length} 张牌。`); return; }
        if (playInfo.strength <= currentMaxStr) { addLog("牌力不足！"); return; }
      } else if (playInfo.type === 'discard') { addLog("牌型不合法。"); return; }
    }
    if (isHost) processPlayCards(PlayerId.PLAYER, selectedCards, isDiscard);
    else sendToHost('ACTION_PLAY', { playerId: PlayerId.PLAYER, cards: selectedCards, isDiscard });
    setSelectedCards([]);
  };

  const handleHint = () => {
    if (gameState.phase !== GamePhase.PLAYING || gameState.turn !== PlayerId.PLAYER) return;
    const targetPlay = gameState.table.length > 0 ? gameState.table[0] : null;
    const currentMaxStr = gameState.table.length > 0 ? Math.max(...gameState.table.map(p => p.strength)) : -1;
    const myHand = gameState.hands[PlayerId.PLAYER];
    const collectedCount = gameState.collected[PlayerId.PLAYER].length;
    
    const recommended = aiDecidePlay(myHand, targetPlay, currentMaxStr, collectedCount);
    setSelectedCards(recommended);
  };

  const handleShareRoom = () => {
    if (!myId) return;
    const baseUrl = window.location.origin + window.location.pathname;
    const shareUrl = `${baseUrl}?room=${myId}`;
    navigator.clipboard.writeText(shareUrl).then(() => {
      addLog("✅ 房间邀请链接已复制！发送给好友即可加入对战。");
    });
  };

  const quitToLobby = () => {
    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }
    connectionsRef.current = {};
    setIsHost(false);
    setConnectedPeers([]);
    setTargetId('');
    setSlots({
      [PlayerId.PLAYER]: { type: 'human', name: '我' },
      [PlayerId.AI_LEFT]: { type: 'empty', name: '等待加入...' },
      [PlayerId.AI_RIGHT]: { type: 'empty', name: '等待加入...' },
    });
    setGameState(INITIAL_GAME_STATE(gameState.starCoins));
    // 清理 URL 参数
    window.history.replaceState({}, document.title, window.location.pathname);
    setTimeout(() => initPeer(), 100);
  };

  const renderLobby = () => (
    <div className="absolute inset-0 z-[500] bg-slate-950/90 backdrop-blur-3xl flex flex-col items-center justify-center p-4">
      <div className="max-w-xl w-full max-h-[95vh] overflow-y-auto space-y-4 md:space-y-8 text-center bg-slate-900/40 p-6 md:p-10 rounded-[3rem] md:rounded-[4rem] border border-white/5 shadow-2xl relative group custom-scrollbar">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-emerald-500/50 to-transparent"></div>
        <div className="space-y-1 md:space-y-2">
          <h1 className="text-4xl md:text-6xl font-black chinese-font text-emerald-500 tracking-tighter">宣坨坨</h1>
          <p className="text-slate-500 text-[8px] md:text-[10px] tracking-[0.5em] uppercase">山西柳林传统扑克</p>
        </div>
        
        <div className="flex flex-col items-center gap-1 md:gap-2">
          <span className="text-[8px] md:text-[10px] text-slate-500 font-bold uppercase tracking-widest">您的联机 ID</span>
          <div className="flex items-center gap-2 bg-black/40 px-3 md:px-4 py-1.5 md:py-2 rounded-2xl border border-white/5">
            <span className="text-[10px] md:text-xs font-mono text-emerald-400 truncate max-w-[150px] md:max-w-none">{myId || '获取 ID 中...'}</span>
            <button onClick={() => {if(myId){navigator.clipboard.writeText(myId); addLog("ID已复制");}}} className="text-[8px] md:text-[10px] bg-emerald-500/10 text-emerald-500 px-1.5 md:px-2 py-0.5 md:py-1 rounded-md hover:bg-emerald-500/20 transition-all">复制</button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6 w-full">
          <div className="space-y-3 md:space-y-4">
            <input value={targetId} onChange={e => setTargetId(e.target.value)} placeholder="输入房号加入..." className="w-full bg-slate-800/50 border border-white/5 rounded-2xl px-6 py-3 md:py-4 text-center focus:ring-2 ring-emerald-500 transition-all text-xs md:text-sm outline-none" />
            <button onClick={joinRoom} disabled={!targetId} className="w-full py-3 md:py-4 bg-slate-100 text-slate-900 font-black rounded-2xl hover:bg-white transition-all active:scale-95 disabled:opacity-20 shadow-xl text-xs md:text-sm">加入对局</button>
          </div>
          <div className="flex flex-col gap-3 md:gap-4">
            <button onClick={() => {setIsHost(true); setGameState(prev => ({...prev, phase: GamePhase.WAITING}));}} className="w-full py-3 md:py-4 bg-emerald-600 font-black rounded-2xl hover:bg-emerald-500 transition-all active:scale-95 shadow-lg shadow-emerald-900/20 text-xs md:text-sm">创建新对局</button>
            <button onClick={() => setShowRules(true)} className="w-full py-3 md:py-4 bg-slate-800 border border-white/5 text-slate-300 font-black rounded-2xl hover:bg-slate-700 transition-all active:scale-95 flex items-center justify-center gap-2 text-xs md:text-sm">📖 玩法教程</button>
          </div>
        </div>
      </div>
    </div>
  );

  const renderRulesModal = () => (
    <div className="absolute inset-0 z-[1000] bg-slate-950/95 backdrop-blur-2xl flex flex-col p-4 md:p-12 animate-in fade-in duration-300">
      <div className="max-w-4xl w-full mx-auto flex flex-col h-full bg-slate-900/50 rounded-[2rem] md:rounded-[3rem] border border-white/5 shadow-2xl overflow-hidden relative">
        <div className="p-4 md:p-12 flex justify-between items-center shrink-0 bg-slate-900/80 border-b border-white/5">
          <div className="flex items-center gap-3 md:gap-4">
            <div className="w-10 h-10 md:w-12 h-12 bg-emerald-500/20 rounded-xl md:rounded-2xl flex items-center justify-center text-xl md:text-2xl">📖</div>
            <div>
              <h2 className="text-xl md:text-3xl font-black chinese-font text-emerald-500">宣坨坨游戏规则</h2>
              <p className="text-[8px] md:text-[10px] text-slate-500 uppercase tracking-widest mt-0.5 md:mt-1">24张牌体系</p>
            </div>
          </div>
          <button onClick={() => setShowRules(false)} className="w-10 h-10 md:w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center text-lg md:text-xl hover:bg-emerald-600 transition-all">✕</button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 md:p-12 space-y-8 md:space-y-12 custom-scrollbar">
          <section className="space-y-3 md:space-y-4">
            <h3 className="text-lg md:text-xl font-black chinese-font text-emerald-400 flex items-center gap-2 border-l-4 border-emerald-500 pl-4">一、牌力排序</h3>
            <div className="bg-black/40 p-4 md:p-6 rounded-2xl md:rounded-3xl border border-white/5 leading-loose">
              <p className="text-xs md:text-base text-slate-300">
                <strong className="text-white">单牌:</strong> 红尔(24) > 黑尔(23) > 红相(22) > 黑相(21) > 红马(20) > 黑马(19) > 红卒(18) > 黑卒(17) > 大王(16) > 红曲(15) > 小王(14) > 黑曲(13)
              </p>
              <p className="text-xs md:text-base text-slate-300 mt-2">
                <strong className="text-white">对子:</strong> 基础对子牌力 = 单牌 + 100；<span className="text-orange-400 font-bold">大小王对 & 红尔对 特殊牌力 = 125(不分胜负)</span>。
              </p>
              <p className="text-xs md:text-base text-slate-300 mt-2">
                <strong className="text-white">三张:</strong> 牌力 = 最大单牌 + 200。仅同色三张曲(JQK)可组合。
              </p>
            </div>
          </section>

          <section className="space-y-3 md:space-y-4">
            <h3 className="text-lg md:text-xl font-black chinese-font text-emerald-400 flex items-center gap-2 border-l-4 border-emerald-500 pl-4">二、核心规则</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
              <div className="bg-slate-800/50 p-4 md:p-6 rounded-2xl md:rounded-3xl border border-white/5">
                <h4 className="font-black text-white mb-2 text-sm md:text-base">出牌规则</h4>
                <p className="text-xs md:text-sm text-slate-400">数量必须相同，牌型必须一致（单打单，对打对）。如果有能打过的牌，<span className="text-emerald-400">必须出牌，禁止扣牌</span>。</p>
              </div>
              <div className="bg-slate-800/50 p-4 md:p-6 rounded-2xl md:rounded-3xl border border-white/5">
                <h4 className="font-black text-white mb-2 text-sm md:text-base">扣牌机制</h4>
                <p className="text-xs md:text-sm text-slate-400">无法压制或选择不出时必须扣牌，扣除数量与首发相同。扣除的牌由本轮赢家收集。</p>
              </div>
            </div>
          </section>

          <section className="space-y-3 md:space-y-4">
            <h3 className="text-lg md:text-xl font-black chinese-font text-emerald-400 flex items-center gap-2 border-l-4 border-emerald-500 pl-4">三、特殊博弈: 扣了与宣</h3>
            <div className="bg-orange-500/5 p-4 md:p-8 rounded-2xl md:rounded-3xl border border-orange-500/20">
              <p className="text-xs md:text-base text-slate-300 italic">发起者认为自己必赢，选择发起“扣了”。</p>
              <ul className="mt-4 space-y-2 md:space-y-3 text-xs md:text-sm text-slate-400">
                <li className="flex gap-2"><span>•</span> <span><strong>扣了:</strong> 同意重发。若两名对手均同意，则本局作废重新洗牌。</span></li>
                <li className="flex gap-2"><span>•</span> <span><strong>宣 (挑战):</strong> 接受对局。若应战者最终输掉（收牌不足9张），需向发起者支付<span className="text-orange-500 font-bold">双倍倍率</span>的额外星光币。</span></li>
              </ul>
            </div>
          </section>

          <section className="space-y-3 md:space-y-4 pb-4">
            <h3 className="text-lg md:text-xl font-black chinese-font text-emerald-400 flex items-center gap-2 border-l-4 border-emerald-500 pl-4">四、结算与等级</h3>
            <div className="overflow-hidden border border-white/5 rounded-2xl md:rounded-3xl">
              <table className="w-full text-xs md:text-sm text-left">
                <thead className="bg-slate-800/80 text-slate-400">
                  <tr>
                    <th className="px-4 md:px-6 py-3 md:py-4">等级</th>
                    <th className="px-4 md:px-6 py-3 md:py-4">收牌数</th>
                    <th className="px-4 md:px-6 py-3 md:py-4">奖励币</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 bg-black/20">
                  <tr><td className="px-4 md:px-6 py-3 md:py-4 font-black">不够</td><td className="px-4 md:px-6 py-3 md:py-4 text-slate-500">0-8张</td><td className="px-4 md:px-6 py-3 md:py-4">0 (赔付)</td></tr>
                  <tr><td className="px-4 md:px-6 py-3 md:py-4 font-black text-emerald-500">刚够</td><td className="px-4 md:px-6 py-3 md:py-4">9-14张</td><td className="px-4 md:px-6 py-3 md:py-4">+1</td></tr>
                  <tr><td className="px-4 md:px-6 py-3 md:py-4 font-black text-emerald-500">五了</td><td className="px-4 md:px-6 py-3 md:py-4">15-17张</td><td className="px-4 md:px-6 py-3 md:py-4">+2</td></tr>
                  <tr><td className="px-4 md:px-6 py-3 md:py-4 font-black text-emerald-500">此了</td><td className="px-4 md:px-6 py-3 md:py-4">18-24张</td><td className="px-4 md:px-6 py-3 md:py-4">+3</td></tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>
        
        <div className="p-4 md:p-12 bg-slate-900/80 border-t border-white/5 flex justify-center shrink-0">
          <button onClick={() => setShowRules(false)} className="px-8 md:px-12 py-3 md:py-4 bg-emerald-600 hover:bg-emerald-500 text-white font-black rounded-xl md:rounded-2xl transition-all shadow-xl active:scale-95 text-xs md:text-base">我明白了</button>
        </div>
      </div>
    </div>
  );

  const renderTableSlot = (pid: PlayerId) => {
    const play = gameState.table.find(p => p.playerId === pid);
    if (!play) return <div className="w-20 md:w-24 opacity-0" />;
    
    let animationClass = "play-animation-bottom";
    if (pid === PlayerId.AI_LEFT) animationClass = "play-animation-left";
    if (pid === PlayerId.AI_RIGHT) animationClass = "play-animation-right";

    return (
      <div key={play.playerId} className={`flex flex-col items-center gap-2 ${animationClass} ${play.playerId === PlayerId.PLAYER ? 'translate-y-20' : ''}`}>
        <div className="flex -space-x-12 md:-space-x-16">{play.cards.map((c, i) => <div key={c.id} style={{ zIndex: i }}><PlayingCard card={c} isBack={play.type === 'discard'} /></div>)}</div>
        <div className="px-3 py-1 bg-slate-900/80 rounded-full text-[10px] font-black border border-white/10 shadow-lg">{play.playerId === PlayerId.PLAYER ? '您' : gameState.aiNames[play.playerId]} · {play.type === 'discard' ? '扣牌' : (play.playerId === gameState.starter ? '出牌' : '跟进')}</div>
      </div>
    );
  };

  return (
    <div className="h-screen w-full flex flex-col bg-slate-950 text-slate-100 overflow-hidden relative landscape:flex-row">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-emerald-900/10 via-slate-950 to-slate-950 pointer-events-none"></div>
      {gameState.phase === GamePhase.LOBBY && renderLobby()}
      {showRules && renderRulesModal()}
      {gameState.phase === GamePhase.WAITING && (
        <div className="absolute inset-0 z-[400] bg-slate-950/95 backdrop-blur-2xl flex flex-col items-center justify-center p-6">
          <div className="flex flex-col items-center gap-2 mb-10">
            <h2 className="text-2xl font-black chinese-font text-emerald-500">等待备战中...</h2>
            {isHost && (
              <button onClick={handleShareRoom} className="px-4 py-1.5 bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 rounded-full text-[10px] font-black hover:bg-emerald-600/30 transition-all flex items-center gap-2">
                🔗 分享房间邀请好友
              </button>
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
                    {isHost && id !== PlayerId.PLAYER && slots[id].type !== 'human' && (
                      <button onClick={() => setSlots(prev => { 
                        const n = {...prev}; 
                        if(n[id].type === 'empty') { 
                          const usedNames = Object.values(slots).map(s => s.name);
                          const name = AI_NAME_POOL.filter(n => !usedNames.includes(n))[0] || 'AI'; 
                          n[id] = { type: 'ai', name }; 
                          setGameState(gs => ({...gs, aiNames: {...gs.aiNames, [id]: name}})); 
                        } else { 
                          n[id] = { type: 'empty', name: '等待加入...' }; 
                          setGameState(gs => ({...gs, aiNames: {...gs.aiNames, [id]: 'AI'}})); 
                        } 
                        return n; 
                      })} className="mt-2 text-[10px] text-emerald-500 hover:underline">
                        {slots[id].type === 'empty' ? '+ 添加 AI' : '× 移除 AI'}
                      </button>
                    )}
                 </div>
              </div>
            ))}
          </div>
          {isHost ? (
            <div className="flex flex-col gap-4 w-full max-w-sm">
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
      <div className="flex-1 flex flex-col h-full relative">
        <div className="h-14 flex justify-between items-center px-4 bg-slate-900/80 backdrop-blur-md border-b border-white/5 z-50">
          <div className="flex items-center gap-4 shrink-0"><div className="flex flex-col"><span className="text-xl font-black text-emerald-500 chinese-font">宣坨坨</span><span className="text-[8px] opacity-40 uppercase tracking-widest leading-none">NETWORK V2.0</span></div></div>
          
          <div className="flex-1 flex justify-center px-4 overflow-hidden">
            <div key={gameState.logs[0]} className="bg-slate-950/40 px-6 py-1.5 rounded-full border border-emerald-500/20 animate-in zoom-in slide-in-from-top-2 duration-300">
               <span className="text-xs md:text-sm font-black text-emerald-400 chinese-font truncate block max-w-[200px] md:max-w-md">
                 {gameState.logs[0] || '对局进行中...'}
               </span>
            </div>
          </div>

          <div className="text-xs font-mono bg-black/60 px-3 py-1.5 rounded-lg border border-white/10 flex items-center gap-2 shrink-0"><span className="text-yellow-500 text-base">🪙</span><span className="font-bold text-yellow-100">{gameState.starCoins[PlayerId.PLAYER]}</span></div>
        </div>
        <div className="flex-1 relative flex items-center justify-center landscape:pb-12">
          {[PlayerId.AI_LEFT, PlayerId.AI_RIGHT].map(id => (
            <div key={id} className={`absolute top-6 ${id === PlayerId.AI_LEFT ? 'left-6' : 'right-6'} flex flex-col items-center gap-2 z-30`}>
              <div className="relative">
                <div className={`w-12 h-12 md:w-16 md:h-16 rounded-2xl border-2 bg-slate-900 flex items-center justify-center text-2xl md:text-3xl shadow-2xl transition-all duration-500 ${gameState.turn === id ? 'border-emerald-500 ring-4 ring-emerald-500/20 scale-110' : 'border-white/10'}`}>{slots[id].type === 'human' ? '侠' : (slots[id].type === 'ai' ? '🤖' : '👴')}</div>
                {(gameState.challengers[id] || 0) > 0 && (
                  <div className="absolute -top-3 -right-3 bg-orange-600 border-2 border-white text-white font-black text-[10px] w-9 h-9 flex items-center justify-center rounded-full shadow-lg animate-bounce">
                    宣x{gameState.challengers[id]}
                  </div>
                )}
              </div>
              <div className="flex flex-col items-center gap-0.5 text-center"><span className="text-[10px] md:text-[11px] font-black text-slate-300 chinese-font">{slots[id].name} ({gameState.hands[id].length})</span><div className="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full text-[8px] md:text-[9px] font-black">已收: {gameState.collected[id].length}</div></div>
            </div>
          ))}
          <div className="flex items-center justify-center gap-8 md:gap-24 z-20 w-full max-w-5xl px-10 scale-90 md:scale-100">{renderTableSlot(PlayerId.AI_LEFT)}{renderTableSlot(PlayerId.PLAYER)}{renderTableSlot(PlayerId.AI_RIGHT)}</div>
          
          <div className="absolute left-6 bottom-4 top-40 w-full max-w-[220px] pointer-events-none z-40 hidden md:flex flex-col justify-end overflow-hidden">
             <div className="pointer-events-auto bg-slate-900/80 p-2 rounded-xl mb-2 border border-emerald-500/30 shadow-lg backdrop-blur-md">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-black text-emerald-400">我的进度:</span>
                  <span className="text-xs font-black text-white">{gameState.collected[PlayerId.PLAYER].length} 张</span>
                </div>
                <div className="w-full bg-slate-800 h-1 rounded-full mt-1 overflow-hidden">
                  <div className="bg-emerald-500 h-full transition-all duration-500" style={{ width: `${Math.min(100, (gameState.collected[PlayerId.PLAYER].length / 18) * 100)}%` }}></div>
                </div>
             </div>
             <div ref={logContainerRef} className="overflow-y-auto pointer-events-auto flex flex-col-reverse gap-2 pr-2 custom-scrollbar mask-top-fade">
               {gameState.logs.map((log, i) => (<div key={i} className={`text-[10px] px-3 py-2 rounded-xl bg-slate-900/70 border border-white/5 backdrop-blur-md animate-in slide-in-from-left duration-500 ${i === 0 ? 'text-emerald-400 border-emerald-500/20 font-bold' : 'text-slate-500 opacity-60'}`}>{log}</div>))}
             </div>
          </div>

          <div className="absolute bottom-32 left-1/2 -translate-x-1/2 z-[45] pointer-events-none">
            {(gameState.challengers[PlayerId.PLAYER] || 0) > 0 && (
               <div className="bg-orange-600/90 border border-white/20 px-4 py-1.5 rounded-full flex items-center gap-2 shadow-2xl backdrop-blur-sm pointer-events-auto animate-in zoom-in duration-300">
                 <span className="text-white font-black chinese-font text-xs">🔥 您已应战(宣 x{gameState.challengers[PlayerId.PLAYER]})</span>
               </div>
            )}
          </div>

          {gameState.phase === GamePhase.KOU_LE_DECISION && (
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-[150] flex items-center justify-center p-6 animate-in fade-in">
              <div className="bg-slate-900 border border-emerald-500/40 p-8 rounded-3xl max-w-sm w-full text-center shadow-2xl">
                <div className="text-3xl mb-4">⚖️</div>
                <h3 className="text-xl font-black text-emerald-500 chinese-font mb-2">“扣了”博弈中</h3>
                
                {(() => {
                  const respondents = getNextRespondents(gameState.kouLeInitiator!);
                  const currentDecider = respondents.find(id => gameState.kouLeResponses[id] === null);
                  const pName = currentDecider === PlayerId.PLAYER ? slots[PlayerId.PLAYER].name : slots[currentDecider!].name;
                  
                  return (
                    <>
                      <p className="text-sm text-slate-400 mb-6">
                        {gameState.kouLeInitiator === PlayerId.PLAYER 
                          ? `您发起博弈，请 ${pName} 表态...` 
                          : `${slots[gameState.kouLeInitiator!].name} 发起博弈，当前 ${pName} 表态...`}
                      </p>
                      
                      {currentDecider === PlayerId.PLAYER ? (
                        <div className="flex gap-4 animate-in slide-in-from-bottom duration-500">
                          <button onClick={() => isHost ? processKouLeResponse(PlayerId.PLAYER, 'agree') : sendToHost('ACTION_KOU_LE_RES', {playerId: PlayerId.PLAYER, response: 'agree'})} className="flex-1 py-4 bg-slate-800 hover:bg-slate-700 rounded-xl font-black transition-all">扣了(同意)</button>
                          <button onClick={() => isHost ? processKouLeResponse(PlayerId.PLAYER, 'challenge') : sendToHost('ACTION_KOU_LE_RES', {playerId: PlayerId.PLAYER, response: 'challenge'})} className="flex-1 py-4 bg-orange-600 hover:bg-orange-500 rounded-xl font-black transition-all">宣(挑战)</button>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center py-4 text-emerald-500">
                           <div className="w-8 h-8 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin mb-3"></div>
                           <span className="text-xs font-black">等待对方思考...</span>
                        </div>
                      )}
                    </>
                  );
                })()}

                <div className="mt-6 space-y-2 text-left">
                  {Object.entries(gameState.kouLeResponses).map(([id, resp]) => resp && id !== gameState.kouLeInitiator && (
                    <div key={id} className={`p-2 rounded-lg flex justify-between items-center transition-all ${resp === 'challenge' ? 'bg-orange-500/10 border border-orange-500/30 animate-pulse' : 'bg-slate-800/50'}`}>
                      <span className={`text-xs font-black ${resp === 'challenge' ? 'text-orange-400' : 'text-slate-400'}`}>{slots[id as PlayerId].name}</span>
                      <span className={`text-[10px] font-black px-2 py-0.5 rounded ${resp === 'challenge' ? 'bg-orange-600 text-white' : 'bg-slate-700 text-slate-400'}`}>{resp === 'agree' ? '扣了' : '应战'}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {showHistory && (
            <div className="absolute inset-0 bg-slate-950/95 backdrop-blur-2xl z-[200] flex flex-col p-4 md:p-8 animate-in slide-in-from-right duration-300">
               <div className="flex justify-between items-center mb-6 shrink-0">
                 <div className="flex items-center gap-3">
                   <h2 className="text-2xl md:text-3xl font-black chinese-font text-emerald-500">本局出牌记录</h2>
                   <div className="px-3 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-[10px] text-emerald-400 font-bold uppercase tracking-widest">Live Record</div>
                 </div>
                 <button onClick={() => setShowHistory(false)} className="w-12 h-12 rounded-full bg-slate-800/80 backdrop-blur-md flex items-center justify-center text-xl hover:bg-emerald-600 hover:scale-110 transition-all shadow-2xl">✕</button>
               </div>
               
               <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
                 {gameState.roundHistory.length === 0 ? (
                   <div className="h-full flex flex-col items-center justify-center text-slate-600">
                     <div className="text-6xl mb-4 grayscale opacity-20">🎴</div>
                     <span className="chinese-font font-black tracking-widest opacity-40">暂无对局历史，开始一局吧</span>
                   </div>
                 ) : (
                   gameState.roundHistory.map((round, idx) => {
                     let winnerId = round[0].playerId;
                     let maxStr = round[0].strength;
                     round.forEach(p => { if (p.strength > maxStr) { maxStr = p.strength; winnerId = p.playerId; } });
                     
                     return (
                       <div key={idx} className="bg-slate-900/40 border border-white/5 rounded-3xl p-4 md:p-6 shadow-xl relative overflow-hidden group hover:border-emerald-500/30 transition-all duration-300">
                         {/* 装饰性背景 */}
                         <div className="absolute top-0 right-0 p-10 bg-emerald-500/5 blur-3xl rounded-full -mr-10 -mt-10 pointer-events-none"></div>
                         
                         <div className="flex justify-between items-center mb-6 relative z-10">
                            <div className="flex items-center gap-4">
                              <span className="text-sm font-black text-slate-500 chinese-font">第 {idx + 1} 轮对局</span>
                              <div className="flex items-center gap-2 bg-emerald-500/20 px-3 py-1 rounded-full ring-1 ring-emerald-500/30">
                                <span className="text-emerald-400 text-[10px] font-black uppercase">胜者:</span>
                                <span className="text-white text-xs font-black chinese-font">{slots[winnerId].name}</span>
                              </div>
                            </div>
                            <div className="text-[10px] font-mono text-slate-700 uppercase tracking-widest">Round Stats</div>
                         </div>

                         <div className="grid grid-cols-3 gap-3 md:gap-6 relative z-10">
                            {[PlayerId.AI_LEFT, PlayerId.PLAYER, PlayerId.AI_RIGHT].map((pid) => {
                              const play = round.find(r => r.playerId === pid);
                              const isWinner = pid === winnerId;
                              const pName = slots[pid].name;

                              return (
                                <div key={pid} className={`flex flex-col gap-3 p-3 md:p-4 rounded-2xl transition-all duration-500 ${isWinner ? 'bg-emerald-500/10 ring-2 ring-emerald-500/40 shadow-[0_0_20px_rgba(16,185,129,0.1)]' : 'bg-black/40 border border-white/5'}`}>
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                       <span className={`text-[10px] md:text-xs font-black chinese-font ${isWinner ? 'text-emerald-400' : 'text-slate-400'}`}>{pName}</span>
                                       {isWinner && <span className="text-[10px] bg-yellow-500 text-yellow-950 px-1.5 py-0.5 rounded-md font-black">🏆 胜</span>}
                                    </div>
                                    <span className={`text-[9px] font-black uppercase tracking-tighter ${play?.type === 'discard' ? 'text-red-500' : (isWinner ? 'text-emerald-400' : 'text-slate-600')}`}>
                                      {play?.type === 'discard' ? '扣牌' : (play?.type === 'pair' ? '对子' : (play?.type === 'triple' ? '三张' : '单张'))}
                                    </span>
                                  </div>

                                  <div className="flex -space-x-8 md:-space-x-12 overflow-visible py-2">
                                    {play?.cards.map((c, ci) => (
                                      <div key={c.id} style={{ zIndex: ci }} className="hover:translate-y-[-4px] transition-transform duration-300">
                                        <PlayingCard card={c} size="small" isBack={play.type === 'discard'} />
                                      </div>
                                    ))}
                                  </div>
                                  
                                  <div className="mt-auto pt-2 border-t border-white/5 flex justify-between items-center">
                                    <span className="text-[8px] text-slate-700 font-bold uppercase">Power</span>
                                    <span className={`text-xs font-mono font-black ${isWinner ? 'text-emerald-400' : 'text-slate-500'}`}>{play?.strength || '-'}</span>
                                  </div>
                                </div>
                              );
                            })}
                         </div>
                       </div>
                     );
                   })
                 )}
               </div>
            </div>
          )}
        </div>
        <div className="h-44 md:h-64 bg-slate-900/95 border-t border-white/5 p-4 flex flex-col items-center justify-end relative z-40">
           <div className="absolute left-6 top-[-25px] px-4 py-1.5 bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-xl text-[10px] font-black md:hidden shadow-lg backdrop-blur-md">已收: {gameState.collected[PlayerId.PLAYER].length}</div>
           
           {gameState.phase === GamePhase.PLAYING && gameState.turn === PlayerId.PLAYER && gameState.table.length === 0 && (
             <button onClick={() => isHost ? processInitiateKouLe(PlayerId.PLAYER) : sendToHost('ACTION_KOU_LE_INIT', {playerId: PlayerId.PLAYER})} className="absolute top-[-55px] left-1/2 -translate-x-1/2 px-8 py-2 bg-orange-900/40 border border-orange-500/30 rounded-full text-orange-400 text-xs font-black hover:bg-orange-800 transition-all z-50 backdrop-blur-md">发起“扣了”？</button>
           )}

           <div className="flex gap-2 justify-center pb-4 px-10 overflow-visible max-w-7xl w-full">
             {playerHandSorted.map((c, i) => { 
                const isSel = selectedCards.some(sc => sc.id === c.id);
                const isHovered = hoveredCardId === c.id;
                const isActive = isSel || isHovered;
                return (
                  <div 
                    key={c.id} 
                    onMouseEnter={() => setHoveredCardId(c.id)}
                    onMouseLeave={() => setHoveredCardId(null)}
                    onClick={() => setSelectedCards(prev => isSel ? prev.filter(sc => sc.id !== c.id) : [...prev, c])} 
                    className={`transition-all duration-300 cursor-pointer relative ${isActive ? '-translate-y-12 scale-110' : ''}`} 
                    style={{ 
                      marginLeft: i === 0 ? 0 : '-2.5rem', 
                      zIndex: i 
                    }}
                  >
                    <div className={isActive ? 'drop-shadow-[0_0_25px_rgba(16,185,129,0.8)]' : 'drop-shadow-lg'}>
                      <PlayingCard card={c} />
                    </div>
                  </div>
                ); 
             })}
           </div>
        </div>
      </div>
      
      {/* 优化后的极简操作栏 */}
      <div className="w-16 md:w-24 landscape:h-screen bg-slate-900/90 border-l border-white/10 flex flex-col items-center justify-center p-3 gap-5 md:gap-7 z-[100] backdrop-blur-lg shadow-2xl">
        <button 
          onClick={() => handleAction(false)} 
          disabled={selectedCards.length === 0 || gameState.turn !== PlayerId.PLAYER} 
          className={`w-12 h-12 md:w-16 md:h-16 flex items-center justify-center rounded-2xl font-black chinese-font transition-all text-xl md:text-3xl border border-white/10 ${selectedCards.length > 0 && gameState.turn === PlayerId.PLAYER ? 'bg-emerald-600 hover:bg-emerald-500 active:scale-90 shadow-[0_0_25px_rgba(16,185,129,0.3)] text-white' : 'bg-slate-800/50 text-slate-700 opacity-40 cursor-not-allowed'}`}
        >
          {gameState.table.length === 0 ? '出' : '跟'}
        </button>

        <button 
          onClick={() => handleAction(true)} 
          disabled={selectedCards.length === 0 || gameState.turn !== PlayerId.PLAYER || !gameState.table.length} 
          className={`w-12 h-12 md:w-16 md:h-16 flex items-center justify-center rounded-2xl font-black chinese-font transition-all text-xl md:text-3xl border border-white/10 ${selectedCards.length > 0 && gameState.turn === PlayerId.PLAYER ? 'bg-orange-700 hover:bg-orange-600 active:scale-90 shadow-[0_0_25px_rgba(194,65,12,0.3)] text-white' : 'bg-slate-800/50 text-slate-700 opacity-40 cursor-not-allowed'}`}
        >
          扣
        </button>
        
        <div className="h-px w-8 bg-white/10"></div>
        
        <button 
          onClick={handleHint} 
          disabled={gameState.phase !== GamePhase.PLAYING || gameState.turn !== PlayerId.PLAYER} 
          className={`w-12 h-12 md:w-16 md:h-16 flex items-center justify-center rounded-2xl font-black chinese-font transition-all text-xl md:text-3xl border border-white/10 ${gameState.turn === PlayerId.PLAYER ? 'bg-indigo-600 hover:bg-indigo-500 active:scale-90 shadow-[0_0_25px_rgba(79,70,229,0.3)] text-white' : 'bg-slate-800/50 text-slate-700 opacity-40 cursor-not-allowed'}`}
        >
          提
        </button>
        
        <button 
          onClick={() => setShowRules(true)} 
          className="w-10 h-10 md:w-14 md:h-14 flex items-center justify-center bg-slate-800 hover:bg-slate-700 rounded-xl text-lg md:text-xl font-black text-slate-400 active:scale-90 transition-all border border-white/5"
        >
          规
        </button>

        <button 
          onClick={() => setShowHistory(true)} 
          className="w-10 h-10 md:w-14 md:h-14 flex items-center justify-center bg-slate-800 hover:bg-slate-700 rounded-xl border border-white/5 font-black text-lg md:text-xl chinese-font transition-all active:scale-90 text-slate-300"
        >
          录
        </button>
      </div>

      {gameState.phase === GamePhase.SETTLEMENT && (
        <div className="absolute inset-0 z-[300] bg-slate-950/98 flex items-center justify-center p-4 backdrop-blur-3xl animate-in zoom-in overflow-hidden">
          <div className="max-w-md w-full max-h-[90vh] flex flex-col bg-slate-900 border border-emerald-500/40 p-5 md:p-10 rounded-[30px] md:rounded-[40px] shadow-2xl text-center overflow-hidden">
            <h2 className="text-xl md:text-4xl font-black chinese-font text-emerald-500 mb-4 md:mb-10 tracking-widest shrink-0">对局结算</h2>
            <div className="flex-1 overflow-y-auto space-y-3 md:space-y-4 mb-4 md:mb-8 pr-2 custom-scrollbar">
              {settlementData.map(res => (
                <div key={res.id} className={`flex justify-between items-center p-4 bg-white/5 rounded-2xl border transition-all ${res.netGain < 0 ? 'border-red-500/30 opacity-70' : (res.netGain > 0 ? 'border-emerald-500/50 scale-105 shadow-[0_0_20px_rgba(16,185,129,0.1)]' : 'border-white/5')}`}>
                  <span className="font-black text-sm md:text-lg chinese-font">{slots[res.id].name}</span>
                  <div className="flex flex-col items-end">
                    <span className={`font-black px-2 md:px-3 py-0.5 md:py-1 rounded-lg text-[10px] md:text-sm ${res.coins > 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>{res.level} ({res.cards}张)</span>
                    <span className={`text-xs md:text-base font-black mt-1 ${res.netGain > 0 ? 'text-yellow-500' : (res.netGain < 0 ? 'text-red-500' : 'text-slate-400')}`}>{res.netGain > 0 ? `+${res.netGain}` : res.netGain} 🪙</span>
                    {res.multiplier > 0 && <span className="text-[8px] md:text-[10px] text-red-400 font-bold uppercase tracking-tighter">⚠️ 应战失败 ({res.multiplier}倍风险支付)</span>}
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
