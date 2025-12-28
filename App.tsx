
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
    if (!this.ctx) this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)());
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

const AI_NAME_POOL = ['王铁柱', '李翠花', '赵大壮', '孙木耳', '钱多多', '周公瑾', '吴二娃', '郑牛牛', '刘大脑袋', '马马虎虎'];

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
  
  const [slots, setSlots] = useState<Record<PlayerId, SlotInfo>>({
    [PlayerId.PLAYER]: { type: 'human', name: '我' },
    [PlayerId.AI_LEFT]: { type: 'empty', name: '等待加入...' },
    [PlayerId.AI_RIGHT]: { type: 'empty', name: '等待加入...' },
  });

  const peerRef = useRef<any>(null);
  const connectionsRef = useRef<Record<string, any>>({});
  const [selectedCards, setSelectedCards] = useState<Card[]>([]);
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

    // 扣了风险支付逻辑 (支持倍数)
    if (gameState.kouLeInitiator) {
      const initiatorStat = stats.find(s => s.id === gameState.kouLeInitiator)!;
      const initiatorRes = results.find(r => r.id === gameState.kouLeInitiator)!;
      
      if (initiatorStat.coins > 0) {
        Object.entries(gameState.challengers).forEach(([chalId, chalCount]) => {
          if (chalCount > 0) {
            const chalStat = stats.find(s => s.id === chalId)!;
            const chalRes = results.find(r => r.id === chalId)!;
            if (chalStat.coins === 0) {
              const riskAmount = initiatorStat.coins * 2 * chalCount; // 倍数累加
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

  // 辅助函数：获取发起者之后的顺序
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
        nextPhase = GamePhase.PLAYING; // 有人宣，阶段直接结束进入对局
      } else {
        newLogs.unshift(`✓ 响应: ${pName} 选择了“扣了”`);
        // 如果是最后一个人表态完了
        if (newRes[respondents[1]] !== null) {
          newLogs.unshift("🤝 结果: 达成共识(均扣了)，正在重新洗牌...");
          nextPhase = GamePhase.SETTLEMENT;
          SoundEngine.play('settle');
        } else {
          // 轮到下一个人表态
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
    peer.on('open', (id: string) => setMyId(id));
    peer.on('connection', (conn: any) => {
      setIsHost(true);
      conn.on('open', () => {
        connectionsRef.current[conn.peer] = conn;
        setConnectedPeers(prev => [...prev, conn.peer]);
        setSlots(prev => {
          const next = { ...prev };
          let assignedPlayerId: PlayerId | null = null;
          if (next[PlayerId.AI_LEFT].type === 'empty') assignedPlayerId = PlayerId.AI_LEFT;
          else if (next[PlayerId.AI_RIGHT].type === 'empty') assignedPlayerId = PlayerId.AI_RIGHT;
          if (assignedPlayerId) {
            next[assignedPlayerId] = { type: 'human', peerId: conn.peer, name: `玩家 ${conn.peer.slice(0,4)}` };
            setGameState(gs => {
              const updated = { ...gs, aiNames: { ...gs.aiNames, [assignedPlayerId!]: next[assignedPlayerId!].name } };
              setTimeout(() => broadcast('SYNC_STATE', updated), 500);
              return updated;
            });
          }
          return { ...next };
        });
        addLog(`系统: 玩家 ${conn.peer.slice(0,4)} 已进入。`);
      });
      conn.on('data', (data: NetworkMessage) => handleNetworkMessage(data));
      conn.on('close', () => { delete connectionsRef.current[conn.peer]; setConnectedPeers(prev => prev.filter(p => p !== conn.peer)); });
    });
  }, [handleNetworkMessage, broadcast, addLog]);

  useEffect(() => {
    initPeer();
    return () => { if (peerRef.current) peerRef.current.destroy(); };
  }, [initPeer]);

  const joinRoom = () => {
    if (!targetId || targetId === myId) return;
    const conn = peerRef.current.connect(targetId);
    conn.on('open', () => { connectionsRef.current[conn.peer] = conn; setConnectedPeers([conn.peer]); addLog(`已成功连接房主 ${targetId.slice(0,4)}。`); setGameState(prev => ({ ...prev, phase: GamePhase.WAITING })); });
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
    setTimeout(() => initPeer(), 100);
  };

  const renderLobby = () => (
    <div className="absolute inset-0 z-[500] bg-slate-950/90 backdrop-blur-3xl flex flex-col items-center justify-center p-6">
      <div className="max-w-xl w-full space-y-8 text-center bg-slate-900/40 p-10 rounded-[4rem] border border-white/5 shadow-2xl">
        <div className="space-y-2"><h1 className="text-5xl font-black chinese-font text-emerald-500 tracking-tighter">宣坨坨</h1><p className="text-slate-500 text-[10px] tracking-[0.5em] uppercase">山西柳林传统扑克</p></div>
        <div className="flex flex-col items-center gap-2"><span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">您的联机 ID</span><div className="flex items-center gap-2 bg-black/40 px-4 py-2 rounded-2xl border border-white/5"><span className="text-xs font-mono text-emerald-400">{myId || '获取 ID 中...'}</span><button onClick={() => {if(myId){navigator.clipboard.writeText(myId); addLog("ID已复制");}}} className="text-[10px] bg-emerald-500/10 text-emerald-500 px-2 py-1 rounded-md hover:bg-emerald-500/20 transition-all">复制</button></div></div>
        <div className="grid grid-cols-2 gap-6 w-full"><div className="space-y-4"><input value={targetId} onChange={e => setTargetId(e.target.value)} placeholder="输入房号加入..." className="w-full bg-slate-800/50 border border-white/5 rounded-2xl px-6 py-4 text-center focus:ring-2 ring-emerald-500 transition-all text-sm" /><button onClick={joinRoom} disabled={!targetId} className="w-full py-4 bg-slate-100 text-slate-900 font-black rounded-2xl hover:bg-white transition-all active:scale-95 disabled:opacity-20 shadow-xl">加入对局</button></div><div className="flex flex-col justify-center"><button onClick={() => {setIsHost(true); setGameState(prev => ({...prev, phase: GamePhase.WAITING}));}} className="w-full h-full py-4 bg-emerald-600 font-black rounded-2xl hover:bg-emerald-500 transition-all active:scale-95 shadow-lg shadow-emerald-900/20">创建新对局</button></div></div>
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
      {gameState.phase === GamePhase.WAITING && (
        <div className="absolute inset-0 z-[400] bg-slate-950/95 backdrop-blur-2xl flex flex-col items-center justify-center p-6">
          <h2 className="text-2xl font-black chinese-font text-emerald-500 mb-12">等待备战中...</h2>
          <div className="flex items-center justify-center gap-12 md:gap-24 mb-16">
            {[PlayerId.AI_LEFT, PlayerId.PLAYER, PlayerId.AI_RIGHT].map(id => (
              <div key={id} className={`flex flex-col items-center gap-4 ${id === PlayerId.PLAYER ? 'mt-20' : ''}`}>
                 <div className={`w-20 h-20 md:w-28 md:h-28 rounded-full border-2 flex items-center justify-center text-4xl shadow-2xl transition-all ${id === PlayerId.PLAYER ? 'border-emerald-500 bg-slate-800' : (slots[id].type === 'empty' ? 'border-dashed border-slate-700 bg-slate-900/50 grayscale' : 'border-emerald-500 bg-slate-800')}`}>
                    {id === PlayerId.PLAYER ? '👤' : (slots[id].type === 'empty' ? '?' : (slots[id].type === 'ai' ? '🤖' : '👴'))}
                 </div>
                 <div className="text-center">
                    <div className="text-xs font-black text-slate-300 chinese-font">{id === PlayerId.PLAYER ? '我自己 (房主)' : slots[id].name}</div>
                    {isHost && id !== PlayerId.PLAYER && slots[id].type !== 'human' && (
                      <button onClick={() => setSlots(prev => { const n = {...prev}; if(n[id].type === 'empty') { const name = AI_NAME_POOL.filter(n => !Object.values(gameState.aiNames).includes(n))[0] || 'AI'; n[id] = { type: 'ai', name }; setGameState(gs => ({...gs, aiNames: {...gs.aiNames, [id]: name}})); } else { n[id] = { type: 'empty', name: '等待加入...' }; setGameState(gs => ({...gs, aiNames: {...gs.aiNames, [id]: 'AI'}})); } return n; })} className="mt-2 text-[10px] text-emerald-500 hover:underline">{slots[id].type === 'empty' ? '+ 添加 AI' : '× 移除 AI'}</button>
                    )}
                 </div>
              </div>
            ))}
          </div>
          {isHost ? (<button onClick={() => initGame()} disabled={slots[PlayerId.AI_LEFT].type === 'empty' || slots[PlayerId.AI_RIGHT].type === 'empty'} className={`px-20 py-6 rounded-3xl font-black text-2xl transition-all chinese-font shadow-2xl ${slots[PlayerId.AI_LEFT].type !== 'empty' && slots[PlayerId.AI_RIGHT].type !== 'empty' ? 'bg-emerald-600 hover:scale-105 active:scale-95' : 'bg-slate-800 text-slate-600 opacity-50 cursor-not-allowed'}`}>开 始 游 戏</button>) : (<div className="text-emerald-500 animate-pulse font-black chinese-font text-xl">房主正在配置席位...</div>)}
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
                <div className={`w-12 h-12 md:w-16 md:h-16 rounded-2xl border-2 bg-slate-900 flex items-center justify-center text-2xl md:text-3xl shadow-2xl transition-all duration-500 ${gameState.turn === id ? 'border-emerald-500 ring-4 ring-emerald-500/20 scale-110' : 'border-white/10'}`}>{slots[id].type === 'ai' ? '🤖' : '👴'}</div>
                {(gameState.challengers[id] || 0) > 0 && (
                  <div className="absolute -top-3 -right-3 bg-orange-600 border-2 border-white text-white font-black text-[10px] w-9 h-9 flex items-center justify-center rounded-full shadow-lg animate-bounce">
                    宣x{gameState.challengers[id]}
                  </div>
                )}
              </div>
              <div className="flex flex-col items-center gap-0.5 text-center"><span className="text-[10px] md:text-[11px] font-black text-slate-300 chinese-font">{gameState.aiNames[id]} ({gameState.hands[id].length})</span><div className="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full text-[8px] md:text-[9px] font-black">已收: {gameState.collected[id].length}</div></div>
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
                  const pName = currentDecider === PlayerId.PLAYER ? '您' : gameState.aiNames[currentDecider!];
                  
                  return (
                    <>
                      <p className="text-sm text-slate-400 mb-6">
                        {gameState.kouLeInitiator === PlayerId.PLAYER 
                          ? `您发起博弈，请 ${pName} 表态...` 
                          : `${gameState.aiNames[gameState.kouLeInitiator!]} 发起博弈，当前 ${pName} 表态...`}
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
                      <span className={`text-xs font-black ${resp === 'challenge' ? 'text-orange-400' : 'text-slate-400'}`}>{id === PlayerId.PLAYER ? '您' : gameState.aiNames[id]}</span>
                      <span className={`text-[10px] font-black px-2 py-0.5 rounded ${resp === 'challenge' ? 'bg-orange-600 text-white' : 'bg-slate-700 text-slate-400'}`}>{resp === 'agree' ? '扣了' : '应战'}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {showHistory && (
            <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-xl z-[200] flex flex-col p-6 animate-in slide-in-from-right duration-300">
               <div className="flex justify-between items-center mb-6">
                 <h2 className="text-2xl font-black chinese-font text-emerald-500">本局出牌记录</h2>
                 <button onClick={() => setShowHistory(false)} className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-xl hover:bg-slate-700 transition-all">✕</button>
               </div>
               <div className="flex-1 overflow-y-auto space-y-6 pr-4 custom-scrollbar">
                 {gameState.roundHistory.length === 0 ? (
                   <div className="h-full flex items-center justify-center text-slate-500 chinese-font">暂无对局记录...</div>
                 ) : (
                   gameState.roundHistory.map((round, idx) => {
                     let winnerId = round[0].playerId;
                     let maxStr = round[0].strength;
                     round.forEach(p => { if (p.strength > maxStr) { maxStr = p.strength; winnerId = p.playerId; } });
                     return (
                       <div key={idx} className="bg-slate-900/50 border border-white/5 rounded-2xl p-4">
                         <div className="flex justify-between items-center mb-4 pb-2 border-b border-white/5">
                            <span className="text-xs font-black text-slate-500 uppercase tracking-widest">Round {idx + 1}</span>
                            <span className="text-xs font-black text-emerald-500 bg-emerald-500/10 px-2 py-1 rounded">胜者: {winnerId === PlayerId.PLAYER ? '我自己' : gameState.aiNames[winnerId]}</span>
                         </div>
                         <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            {round.map((play, pIdx) => (
                              <div key={pIdx} className={`flex flex-col gap-2 p-2 rounded-xl ${play.playerId === winnerId ? 'bg-emerald-500/5 ring-1 ring-emerald-500/20' : 'bg-black/20'}`}>
                                <div className="flex items-center justify-between text-[10px] font-black text-slate-400">
                                   <span>{play.playerId === PlayerId.PLAYER ? '您' : gameState.aiNames[play.playerId]}</span>
                                   <span>{play.type === 'discard' ? '扣牌' : (play.type === 'pair' ? '对子' : (play.type === 'triple' ? '三张' : '单张'))}</span>
                                </div>
                                <div className="flex -space-x-8 scale-75 origin-left">
                                  {play.cards.map(c => <PlayingCard key={c.id} card={c} isMini isBack={play.type === 'discard'} />)}
                                </div>
                              </div>
                            ))}
                         </div>
                       </div>
                     );
                   })
                 )}
               </div>
            </div>
          )}
        </div>
        <div className="h-44 md:h-64 bg-slate-900/95 border-t border-white/5 p-4 flex items-end justify-center relative z-40">
           <div className="absolute left-6 top-[-25px] px-4 py-1.5 bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-xl text-[10px] font-black md:hidden shadow-lg backdrop-blur-md">已收: {gameState.collected[PlayerId.PLAYER].length}</div>
           {gameState.phase === GamePhase.PLAYING && gameState.turn === PlayerId.PLAYER && gameState.table.length === 0 && (<button onClick={() => isHost ? processInitiateKouLe(PlayerId.PLAYER) : sendToHost('ACTION_KOU_LE_INIT', {playerId: PlayerId.PLAYER})} className="absolute top-[-50px] left-1/2 -translate-x-1/2 px-8 py-2 bg-orange-900/40 border border-orange-500/30 rounded-full text-orange-400 text-xs font-black hover:bg-orange-800 transition-all z-50 backdrop-blur-md">发起“扣了”？</button>)}
           <div className="flex-1 flex gap-2 justify-center pb-4 px-10 overflow-visible max-w-7xl">
             {playerHandSorted.map((c, i) => { const isSel = selectedCards.some(sc => sc.id === c.id); return (<div key={c.id} onClick={() => setSelectedCards(prev => isSel ? prev.filter(sc => sc.id !== c.id) : [...prev, c])} className={`transition-all duration-300 cursor-pointer relative ${isSel ? '-translate-y-12 scale-110' : 'hover:-translate-y-8 hover:scale-105'}`} style={{ marginLeft: i === 0 ? 0 : '-2.5rem', zIndex: isSel ? 500 : 10 + i }}><div className={isSel ? 'drop-shadow-[0_0_25px_rgba(16,185,129,0.8)]' : 'drop-shadow-lg'}><PlayingCard card={c} /></div></div>); })}
           </div>
        </div>
      </div>
      <div className="w-20 md:w-28 landscape:h-screen bg-slate-900 border-l border-white/10 flex flex-col items-center justify-center p-4 gap-4 md:gap-4 z-[100]">
        <button onClick={() => handleAction(false)} disabled={selectedCards.length === 0 || gameState.turn !== PlayerId.PLAYER} className={`w-full py-4 md:py-7 rounded-xl md:rounded-2xl font-black chinese-font transition-all text-base md:text-xl border border-white/5 ${selectedCards.length > 0 && gameState.turn === PlayerId.PLAYER ? 'bg-emerald-600 hover:bg-emerald-500 active:scale-90 shadow-[0_0_20px_rgba(16,185,129,0.2)]' : 'bg-slate-800 text-slate-600 opacity-30 cursor-not-allowed'}`}>{gameState.table.length === 0 ? '出' : '跟'}<br/>{gameState.table.length === 0 ? '牌' : '进'}</button>
        <button onClick={() => handleAction(true)} disabled={selectedCards.length === 0 || gameState.turn !== PlayerId.PLAYER || !gameState.table.length} className={`w-full py-4 md:py-7 rounded-xl md:rounded-2xl font-black chinese-font transition-all text-base md:text-xl border border-white/5 ${selectedCards.length > 0 && gameState.turn === PlayerId.PLAYER ? 'bg-orange-700 hover:bg-orange-600 active:scale-90' : 'bg-slate-800 text-slate-600 opacity-30 cursor-not-allowed'}`}>扣<br/>牌</button>
        <div className="h-px w-full bg-white/5"></div>
        <button onClick={() => setSelectedCards([])} className="w-full py-2 bg-slate-800 rounded-xl text-[10px] md:text-xs font-black text-slate-400 active:scale-90 transition-all">清 空</button>
        <button onClick={() => setShowHistory(true)} className="w-full py-3 md:py-5 bg-slate-800 rounded-xl md:rounded-2xl border border-white/5 font-black text-xs md:text-sm chinese-font hover:bg-slate-700 transition-all active:scale-90">对 局<br/>记 录</button>
      </div>
      {gameState.phase === GamePhase.SETTLEMENT && (
        <div className="absolute inset-0 z-[300] bg-slate-950/98 flex items-center justify-center p-4 backdrop-blur-3xl animate-in zoom-in overflow-hidden">
          <div className="max-w-md w-full max-h-[90vh] flex flex-col bg-slate-900 border border-emerald-500/40 p-5 md:p-10 rounded-[30px] md:rounded-[40px] shadow-2xl text-center overflow-hidden">
            <h2 className="text-xl md:text-4xl font-black chinese-font text-emerald-500 mb-4 md:mb-10 tracking-widest shrink-0">对局结算</h2>
            <div className="flex-1 overflow-y-auto space-y-3 md:space-y-4 mb-4 md:mb-8 pr-2 custom-scrollbar">
              {settlementData.map(res => (
                <div key={res.id} className={`flex justify-between items-center p-4 bg-white/5 rounded-2xl border transition-all ${res.netGain < 0 ? 'border-red-500/30 opacity-70' : (res.netGain > 0 ? 'border-emerald-500/50 scale-105 shadow-[0_0_20px_rgba(16,185,129,0.1)]' : 'border-white/5')}`}>
                  <span className="font-black text-sm md:text-lg chinese-font">{res.id === PlayerId.PLAYER ? '您自己' : gameState.aiNames[res.id]}</span>
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
