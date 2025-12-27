
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
  },
  play(type: 'deal' | 'play' | 'win' | 'settle' | 'victory' | 'defeat') {
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

const App: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>({
    phase: GamePhase.LOBBY,
    hands: { [PlayerId.PLAYER]: [], [PlayerId.AI_LEFT]: [], [PlayerId.AI_RIGHT]: [] },
    collected: { [PlayerId.PLAYER]: [], [PlayerId.AI_LEFT]: [], [PlayerId.AI_RIGHT]: [] },
    table: [],
    turn: PlayerId.PLAYER,
    starter: PlayerId.PLAYER,
    starCoins: { [PlayerId.PLAYER]: INITIAL_STAR_COINS, [PlayerId.AI_LEFT]: INITIAL_STAR_COINS, [PlayerId.AI_RIGHT]: INITIAL_STAR_COINS },
    kouLeInitiator: null,
    challengers: [],
    kouLeResponses: { [PlayerId.PLAYER]: null, [PlayerId.AI_LEFT]: null, [PlayerId.AI_RIGHT]: null },
    logs: ['系统: 宣坨坨联机大厅已就绪。'],
    aiNames: { [PlayerId.AI_LEFT]: 'AI 左', [PlayerId.AI_RIGHT]: 'AI 右' },
    roundHistory: [],
    nextStarter: null
  });

  const [myId, setMyId] = useState<string>('');
  const [targetId, setTargetId] = useState<string>('');
  const [isHost, setIsHost] = useState<boolean>(false);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  
  const [slots, setSlots] = useState<Record<PlayerId, SlotInfo>>({
    [PlayerId.PLAYER]: { type: 'human', name: '我' },
    [PlayerId.AI_LEFT]: { type: 'empty', name: '等待加入...' },
    [PlayerId.AI_RIGHT]: { type: 'empty', name: '等待加入...' },
  });

  const peerRef = useRef<any>(null);
  const connectionsRef = useRef<Record<string, any>>({});
  const [selectedCards, setSelectedCards] = useState<Card[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);

  const addLog = useCallback((msg: string) => {
    setGameState(prev => ({ ...prev, logs: [msg, ...prev.logs].slice(0, 8) }));
  }, []);

  const broadcast = useCallback((type: string, payload: any) => {
    Object.values(connectionsRef.current).forEach((conn: any) => {
      conn.send({ type, payload, senderId: peerRef.current?.id });
    });
  }, []);

  const sendToHost = useCallback((type: string, payload: any) => {
    if (isHost) return;
    const hostConn = Object.values(connectionsRef.current)[0];
    if (hostConn) hostConn.send({ type, payload, senderId: peerRef.current?.id });
  }, [isHost]);

  const initGame = useCallback((preservedStarter?: PlayerId) => {
    if (!isHost) return;
    SoundEngine.play('deal');
    const deck = createDeck().sort(() => Math.random() - 0.5);
    const hands = {
      [PlayerId.PLAYER]: deck.slice(0, 8),
      [PlayerId.AI_LEFT]: deck.slice(8, 16),
      [PlayerId.AI_RIGHT]: deck.slice(16, 24),
    };
    if (Object.values(hands).some(h => checkNoXiang(h))) {
      addLog("系统: 有人手牌‘无相’，重新洗牌...");
      setTimeout(() => initGame(preservedStarter), 1000);
      return;
    }
    const starter = preservedStarter || [PlayerId.PLAYER, PlayerId.AI_LEFT, PlayerId.AI_RIGHT][Math.floor(Math.random() * 3)];
    setGameState(prev => {
      const newState: GameState = {
        ...prev,
        phase: GamePhase.PLAYING,
        hands,
        collected: { [PlayerId.PLAYER]: [], [PlayerId.AI_LEFT]: [], [PlayerId.AI_RIGHT]: [] },
        table: [],
        turn: starter,
        starter: starter,
        roundHistory: [],
        kouLeInitiator: null,
        challengers: [],
        kouLeResponses: { [PlayerId.PLAYER]: null, [PlayerId.AI_LEFT]: null, [PlayerId.AI_RIGHT]: null },
        logs: [`房主发牌完成！${starter === PlayerId.PLAYER ? '您' : prev.aiNames[starter]} 先出牌。`, ...prev.logs].slice(0, 8),
        nextStarter: null
      };
      broadcast('SYNC_STATE', newState);
      return newState;
    });
  }, [isHost, broadcast, addLog]);

  const processKouLeResponse = useCallback((pid: PlayerId, resp: 'agree' | 'challenge') => {
    setGameState(prev => {
      const newRes = { ...prev.kouLeResponses, [pid]: resp };
      const newLogs = [...prev.logs];
      const pName = pid === PlayerId.PLAYER ? '您' : prev.aiNames[pid];
      
      if (resp === 'challenge') {
        newLogs.unshift(`⚡ 提醒: ${pName} 选择了“宣”(挑战)！风险加倍！`);
      } else {
        newLogs.unshift(`✓ 提示: ${pName} 选择了“扣了”(同意)`);
      }

      const players = [PlayerId.PLAYER, PlayerId.AI_LEFT, PlayerId.AI_RIGHT];
      let nextPhase = GamePhase.KOU_LE_DECISION;
      let challengers = prev.challengers;

      if (players.every(p => newRes[p] !== null)) {
        challengers = players.filter(p => newRes[p] === 'challenge') as PlayerId[];
        if (challengers.length === 0) {
          newLogs.unshift("系统: 三方达成共识，正在重新发牌...");
          setTimeout(() => initGame(prev.kouLeInitiator!), 1000);
        } else {
          newLogs.unshift(`博弈结束: 挑战者共 ${challengers.length} 位。游戏继续！`);
          nextPhase = GamePhase.PLAYING;
        }
      }

      const nextS = { 
        ...prev, 
        phase: nextPhase, 
        kouLeResponses: newRes, 
        challengers, 
        logs: newLogs.slice(0, 10) 
      };
      if (isHost) broadcast('SYNC_STATE', nextS);
      return nextS;
    });
  }, [isHost, broadcast, initGame]);

  const handleNetworkMessage = useCallback((msg: NetworkMessage) => {
    switch (msg.type) {
      case 'SYNC_STATE': setGameState(msg.payload); break;
      case 'ACTION_PLAY': if (isHost) processPlayCards(msg.payload.playerId, msg.payload.cards, msg.payload.isDiscard); break;
      case 'ACTION_KOU_LE_INIT': if (isHost) processInitiateKouLe(msg.payload.playerId); break;
      case 'ACTION_KOU_LE_RES': if (isHost) processKouLeResponse(msg.payload.playerId, msg.payload.response); break;
    }
  }, [isHost, processKouLeResponse]);

  useEffect(() => {
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
        addLog(`系统: 玩家 ${conn.peer.slice(0,4)} 已连接。`);
      });
      conn.on('data', (data: NetworkMessage) => handleNetworkMessage(data));
    });
    return () => peer.destroy();
  }, [handleNetworkMessage, broadcast, addLog]);

  const joinRoom = () => {
    if (!targetId || targetId === myId) return;
    const conn = peerRef.current.connect(targetId);
    conn.on('open', () => {
      connectionsRef.current[conn.peer] = conn;
      setConnectedPeers([conn.peer]);
      addLog(`已连接房主 ${targetId.slice(0,4)}。`);
      setGameState(prev => ({ ...prev, phase: GamePhase.WAITING }));
    });
    conn.on('data', (data: NetworkMessage) => handleNetworkMessage(data));
  };

  const toggleAI = (slotId: PlayerId) => {
    if (!isHost) return;
    setSlots(prev => {
      const next = { ...prev };
      if (prev[slotId].type === 'empty') {
        // 确保 AI 名字不重复
        const currentNames = Object.values(gameState.aiNames);
        const availableNames = AI_NAME_POOL.filter(n => !currentNames.includes(n));
        const name = availableNames[Math.floor(Math.random() * availableNames.length)] || '神秘客';
        
        next[slotId] = { type: 'ai', name };
        setGameState(gs => {
          const updated = { ...gs, aiNames: { ...gs.aiNames, [slotId]: name } };
          broadcast('SYNC_STATE', updated);
          return updated;
        });
      } else {
        next[slotId] = { type: 'empty', name: '等待加入...' };
        setGameState(gs => {
          const updated = { ...gs, aiNames: { ...gs.aiNames, [slotId]: slotId === PlayerId.AI_LEFT ? 'AI 左' : 'AI 右' } };
          broadcast('SYNC_STATE', updated);
          return updated;
        });
      }
      return { ...next };
    });
  };

  const processPlayCards = (playerId: PlayerId, cards: Card[], isDiscard: boolean = false) => {
    setGameState(prev => {
      const { strength, type } = calculatePlayStrength(cards);
      const finalStrength = isDiscard ? -1 : strength;
      const newTable = [...prev.table, { playerId, cards, type: isDiscard ? 'discard' : type, strength: finalStrength }];
      const nextS = {
        ...prev,
        hands: { ...prev.hands, [playerId]: prev.hands[playerId].filter(c => !cards.some(sc => sc.id === c.id)) },
        table: newTable,
        turn: (playerId === PlayerId.AI_LEFT ? PlayerId.PLAYER : (playerId === PlayerId.PLAYER ? PlayerId.AI_RIGHT : PlayerId.AI_LEFT)) as PlayerId
      };
      if (newTable.length === 3) setTimeout(resolveRound, 800);
      if (isHost) broadcast('SYNC_STATE', nextS);
      return nextS;
    });
    SoundEngine.play('play');
  };

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
        logs: [`系统: ${winnerId === PlayerId.PLAYER ? '您' : prev.aiNames[winnerId]} 赢得了本轮！`, ...prev.logs].slice(0, 8),
        nextStarter: winnerId
      };
      broadcast('SYNC_STATE', nextS);
      return nextS;
    });
    setTimeout(() => {
      setGameState(prev => {
        const gameOver = Object.values(prev.hands).some(h => h.length === 0);
        const nextS: GameState = gameOver 
          ? { ...prev, phase: GamePhase.SETTLEMENT } 
          : { ...prev, phase: GamePhase.PLAYING, table: [], turn: prev.nextStarter!, starter: prev.nextStarter!, nextStarter: null };
        broadcast('SYNC_STATE', nextS);
        return nextS;
      });
    }, 1500);
  }, [isHost, broadcast]);

  const processInitiateKouLe = (pid: PlayerId) => {
    setGameState(prev => {
      const nextS: GameState = {
        ...prev, phase: GamePhase.KOU_LE_DECISION, kouLeInitiator: pid,
        kouLeResponses: { [PlayerId.PLAYER]: null, [PlayerId.AI_LEFT]: null, [PlayerId.AI_RIGHT]: null, [pid]: 'agree' },
        logs: [`⚠️ 警报: ${pid === PlayerId.PLAYER ? '您' : prev.aiNames[pid]} 发起了“扣了”！请表态。`, ...prev.logs].slice(0, 8),
      };
      if (isHost) broadcast('SYNC_STATE', nextS);
      return nextS;
    });
  };

  const settlementData = useMemo(() => {
    const players = [PlayerId.PLAYER, PlayerId.AI_LEFT, PlayerId.AI_RIGHT];
    const stats = players.map(pid => {
      const count = gameState.collected[pid].length;
      return { id: pid, cards: count, ...getRewardInfo(count) };
    });

    const winners = stats.filter(s => s.coins > 0);
    const losers = stats.filter(s => s.coins === 0);

    const results = stats.map(s => ({
      ...s,
      netGain: 0,
      isChallengerFailed: false
    }));

    // 基础支付：每个输家支付给每个赢家其对应的奖励金额
    results.forEach(res => {
      const stat = stats.find(s => s.id === res.id)!;
      if (stat.coins > 0) {
        // 赢家从每个输家那里各拿一份钱
        res.netGain = stat.coins * losers.length;
      } else {
        // 输家支付给所有赢家
        const totalToPay = winners.reduce((sum, w) => sum + w.coins, 0);
        res.netGain = -totalToPay;
      }
    });

    // 风险结算：如果存在“宣”失败的情况
    if (gameState.kouLeInitiator && gameState.challengers.length > 0) {
      const initiatorRes = results.find(r => r.id === gameState.kouLeInitiator)!;
      const initiatorBaseReward = stats.find(s => s.id === gameState.kouLeInitiator)!.coins;
      
      // 发起者必须是赢家，才会触发风险赔偿
      if (initiatorBaseReward > 0) {
        gameState.challengers.forEach(chalId => {
          const challengerRes = results.find(r => r.id === chalId)!;
          const challengerBaseReward = stats.find(s => s.id === chalId)!.coins;
          
          if (challengerBaseReward === 0) {
            const riskAmount = initiatorBaseReward * 2;
            challengerRes.netGain -= riskAmount;
            challengerRes.isChallengerFailed = true;
            initiatorRes.netGain += riskAmount;
          }
        });
      }
    }

    return results;
  }, [gameState]);

  useEffect(() => {
    if (!isHost) return;
    if (gameState.phase === GamePhase.PLAYING && gameState.turn !== PlayerId.PLAYER) {
      if (slots[gameState.turn].type === 'ai') {
        const timer = setTimeout(() => {
          const targetPlay = gameState.table.length > 0 ? gameState.table[0] : null;
          const currentMaxStr = gameState.table.length > 0 ? Math.max(...gameState.table.map(p => p.strength)) : -1;
          const toPlay = aiDecidePlay(gameState.hands[gameState.turn], targetPlay, currentMaxStr, gameState.collected[gameState.turn].length);
          const isDiscard = targetPlay && calculatePlayStrength(toPlay).strength <= currentMaxStr;
          processPlayCards(gameState.turn, toPlay, isDiscard || false);
        }, 1500);
        return () => clearTimeout(timer);
      }
    }
    if (gameState.phase === GamePhase.KOU_LE_DECISION) {
      const aiSlotsToRespond = ([PlayerId.AI_LEFT, PlayerId.AI_RIGHT] as PlayerId[]).filter(
        id => slots[id].type === 'ai' && gameState.kouLeResponses[id] === null
      );
      if (aiSlotsToRespond.length > 0) {
        const timer = setTimeout(() => {
          aiSlotsToRespond.forEach(aiId => {
            const decision = aiEvaluateKouLe(gameState.hands[aiId], gameState.collected[aiId].length);
            processKouLeResponse(aiId, decision);
          });
        }, 1500);
        return () => clearTimeout(timer);
      }
    }
  }, [gameState.phase, gameState.turn, isHost, gameState.table, slots, gameState.kouLeResponses, processKouLeResponse]);

  const handleAction = (isDiscard: boolean) => {
    const currentMaxStr = gameState.table.length > 0 ? Math.max(...gameState.table.map(p => p.strength)) : -1;
    const targetPlay = gameState.table.length > 0 ? gameState.table[0] : null;
    if (isDiscard) {
      if (getValidPlays(gameState.hands[PlayerId.PLAYER], targetPlay, currentMaxStr).length > 0) { addLog("有管上的牌，必须出牌！"); return; }
      if (selectedCards.length !== (targetPlay?.cards.length || 0)) { addLog(`需扣 ${targetPlay?.cards.length} 张。`); return; }
    } else {
      const playInfo = calculatePlayStrength(selectedCards);
      if (targetPlay) {
        if (selectedCards.length !== targetPlay.cards.length) { addLog(`数量不符，需出 ${targetPlay.cards.length} 张。`); return; }
        if (playInfo.strength <= currentMaxStr) { addLog("牌力不足！"); return; }
      } else if (playInfo.type === 'discard') { addLog("牌型不合法。"); return; }
    }
    if (isHost) processPlayCards(PlayerId.PLAYER, selectedCards, isDiscard);
    else sendToHost('ACTION_PLAY', { playerId: PlayerId.PLAYER, cards: selectedCards, isDiscard });
    setSelectedCards([]);
  };

  const renderLobby = () => (
    <div className="absolute inset-0 z-[500] bg-slate-950/90 backdrop-blur-3xl flex flex-col items-center justify-center p-6">
      <div className="max-w-xl w-full space-y-8 text-center bg-slate-900/40 p-10 rounded-[4rem] border border-white/5 shadow-2xl">
        <div className="space-y-2">
          <h1 className="text-5xl font-black chinese-font text-emerald-500 tracking-tighter">宣坨坨</h1>
          <p className="text-slate-500 text-[10px] tracking-[0.5em] uppercase">Multiplayer / AI Mixed Mode</p>
        </div>
        <div className="flex flex-col items-center gap-2">
          <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">您的联机 ID (房号)</span>
          <div className="flex items-center gap-2 bg-black/40 px-4 py-2 rounded-2xl border border-white/5">
            <span className="text-xs font-mono text-emerald-400">{myId || '正在分配地址...'}</span>
            <button onClick={() => {if(myId){navigator.clipboard.writeText(myId); addLog("ID已复制");}}} className="text-[10px] bg-emerald-500/10 text-emerald-500 px-2 py-1 rounded-md hover:bg-emerald-500/20 transition-all">复制</button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-6 w-full">
           <div className="space-y-4">
              <input value={targetId} onChange={e => setTargetId(e.target.value)} placeholder="输入房号加入..." className="w-full bg-slate-800/50 border border-white/5 rounded-2xl px-6 py-4 text-center focus:ring-2 ring-emerald-500 transition-all text-sm" />
              <button onClick={joinRoom} disabled={!targetId} className="w-full py-4 bg-slate-100 text-slate-900 font-black rounded-2xl hover:bg-white transition-all active:scale-95 disabled:opacity-20 shadow-xl">加入房间</button>
           </div>
           <div className="flex flex-col justify-center">
              <button onClick={() => {setIsHost(true); setGameState(prev => ({...prev, phase: GamePhase.WAITING}));}} className="w-full h-full py-4 bg-emerald-600 font-black rounded-2xl hover:bg-emerald-500 transition-all active:scale-95 shadow-lg shadow-emerald-900/20">创建对局 (作为房主)</button>
           </div>
        </div>
      </div>
    </div>
  );

  const renderWaiting = () => {
    const isReady = slots[PlayerId.AI_LEFT].type !== 'empty' && slots[PlayerId.AI_RIGHT].type !== 'empty';
    return (
      <div className="absolute inset-0 z-[400] bg-slate-950/95 backdrop-blur-2xl flex flex-col items-center justify-center p-6">
        <h2 className="text-2xl font-black chinese-font text-emerald-500 mb-12">等待备战中...</h2>
        <div className="flex items-center justify-center gap-12 md:gap-24 mb-16">
          <div className="flex flex-col items-center gap-4">
             <div className={`w-20 h-20 md:w-28 md:h-28 rounded-full border-2 flex items-center justify-center text-4xl shadow-2xl transition-all ${slots[PlayerId.AI_LEFT].type === 'empty' ? 'border-dashed border-slate-700 bg-slate-900/50 grayscale' : 'border-emerald-500 bg-slate-800'}`}>
                {slots[PlayerId.AI_LEFT].type === 'empty' ? '?' : (slots[PlayerId.AI_LEFT].type === 'ai' ? '🤖' : '👴')}
             </div>
             <div className="text-center">
               <div className="text-xs font-black text-slate-300 chinese-font">{slots[PlayerId.AI_LEFT].name}</div>
               {isHost && slots[PlayerId.AI_LEFT].type !== 'human' && (
                 <button onClick={() => toggleAI(PlayerId.AI_LEFT)} className="mt-2 text-[10px] text-emerald-500 hover:underline">{slots[PlayerId.AI_LEFT].type === 'empty' ? '+ 添加 AI' : '× 移除 AI'}</button>
               )}
             </div>
          </div>
          <div className="flex flex-col items-center gap-4 mt-20">
             <div className="w-24 h-24 md:w-32 md:h-32 rounded-full border-4 border-emerald-500 bg-slate-800 flex items-center justify-center text-5xl shadow-[0_0_50px_rgba(16,185,129,0.3)]">👤</div>
             <div className="text-center font-black text-emerald-400 chinese-font">我自己 (房主)</div>
          </div>
          <div className="flex flex-col items-center gap-4">
             <div className={`w-20 h-20 md:w-28 md:h-28 rounded-full border-2 flex items-center justify-center text-4xl shadow-2xl transition-all ${slots[PlayerId.AI_RIGHT].type === 'empty' ? 'border-dashed border-slate-700 bg-slate-900/50 grayscale' : 'border-emerald-500 bg-slate-800'}`}>
                {slots[PlayerId.AI_RIGHT].type === 'empty' ? '?' : (slots[PlayerId.AI_RIGHT].type === 'ai' ? '🤖' : '🧔')}
             </div>
             <div className="text-center">
               <div className="text-xs font-black text-slate-300 chinese-font">{slots[PlayerId.AI_RIGHT].name}</div>
               {isHost && slots[PlayerId.AI_RIGHT].type !== 'human' && (
                 <button onClick={() => toggleAI(PlayerId.AI_RIGHT)} className="mt-2 text-[10px] text-emerald-500 hover:underline">{slots[PlayerId.AI_RIGHT].type === 'empty' ? '+ 添加 AI' : '× 移除 AI'}</button>
               )}
             </div>
          </div>
        </div>
        {isHost ? (
          <button onClick={() => initGame()} disabled={!isReady} className={`px-20 py-6 rounded-3xl font-black text-2xl transition-all chinese-font shadow-2xl ${isReady ? 'bg-emerald-600 hover:scale-105 active:scale-95' : 'bg-slate-800 text-slate-600 opacity-50 cursor-not-allowed'}`}>
            {isReady ? '开 始 游 戏' : '满 三 人 方 可 开 局'}
          </button>
        ) : (
          <div className="text-emerald-500 animate-pulse font-black chinese-font text-xl">房主正在配置席位...</div>
        )}
      </div>
    );
  };

  const renderTableSlot = (pid: PlayerId) => {
    const play = gameState.table.find(p => p.playerId === pid);
    if (!play) return <div className="w-20 md:w-24 opacity-0" />;
    return (
      <div key={play.playerId} className={`flex flex-col items-center gap-2 animate-in zoom-in duration-300 ${play.playerId === PlayerId.PLAYER ? 'translate-y-12' : ''}`}>
        <div className="flex -space-x-12 md:-space-x-16">
          {play.cards.map((c, i) => <div key={c.id} style={{ zIndex: i }}><PlayingCard card={c} isBack={play.type === 'discard'} /></div>)}
        </div>
        <div className="px-3 py-1 bg-slate-900/80 rounded-full text-[10px] font-black border border-white/10 shadow-lg">
          {play.playerId === PlayerId.PLAYER ? '您' : gameState.aiNames[play.playerId]} · {play.type === 'discard' ? '扣牌' : (play.playerId === gameState.starter ? '出牌' : '跟进')}
        </div>
      </div>
    );
  };

  const playerHandSorted = useMemo(() => {
    const others = gameState.hands[PlayerId.PLAYER].filter(c => c.name !== '大王' && c.name !== '小王');
    const kings = gameState.hands[PlayerId.PLAYER].filter(c => c.name === '大王' || c.name === '小王').sort((a,b) => a.strength - b.strength);
    const sortedOthers = others.sort((a,b) => a.strength - b.strength);
    const result = [...sortedOthers];
    const insertIdx = result.findIndex(c => c.strength >= 14);
    if (insertIdx === -1) result.push(...kings); else result.splice(insertIdx, 0, ...kings);
    return result;
  }, [gameState.hands]);

  return (
    <div className="h-screen w-full flex flex-col bg-slate-950 text-slate-100 overflow-hidden relative landscape:flex-row">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-emerald-900/10 via-slate-950 to-slate-950 pointer-events-none"></div>
      {gameState.phase === GamePhase.LOBBY && renderLobby()}
      {gameState.phase === GamePhase.WAITING && renderWaiting()}
      <div className="flex-1 flex flex-col h-full relative">
        <div className="h-14 flex justify-between items-center px-4 bg-slate-900/80 backdrop-blur-md border-b border-white/5 z-50">
          <div className="flex items-center gap-4">
             <div className="flex flex-col">
               <span className="text-xl font-black text-emerald-500 chinese-font">宣坨坨</span>
               <span className="text-[8px] opacity-40 uppercase tracking-widest">P2P Network Mode</span>
             </div>
             <div className="flex items-center gap-1.5 px-3 py-1 bg-black/40 rounded-full border border-white/5">
                <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${connectedPeers.length > 0 ? 'bg-emerald-500' : 'bg-red-500'}`}></div>
                <span className="text-[9px] font-bold text-slate-400 uppercase">{connectedPeers.length + 1} 人连接</span>
             </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-xs font-mono bg-black/60 px-3 py-1.5 rounded-lg border border-white/10 flex items-center gap-2">
               <span className="text-yellow-500 text-base">🪙</span>
               <span className="font-bold text-yellow-100">{gameState.starCoins[PlayerId.PLAYER]}</span>
            </div>
          </div>
        </div>
        <div className="flex-1 relative flex items-center justify-center landscape:pb-12">
          <div className="absolute top-6 left-6 flex flex-col items-center gap-2 z-30">
            <div className={`w-12 h-12 md:w-16 md:h-16 rounded-2xl border-2 bg-slate-900 flex items-center justify-center text-2xl md:text-3xl shadow-2xl transition-all duration-500 ${gameState.turn === PlayerId.AI_LEFT ? 'border-emerald-500 ring-4 ring-emerald-500/20 scale-110' : 'border-white/10'}`}>
               {slots[PlayerId.AI_LEFT].type === 'ai' ? '🤖' : '👴'}
            </div>
            <div className="flex flex-col items-center gap-0.5 text-center">
               <span className="text-[10px] md:text-[11px] font-black text-slate-300 chinese-font">{gameState.aiNames[PlayerId.AI_LEFT]} ({gameState.hands[PlayerId.AI_LEFT].length})</span>
               <div className="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full text-[8px] md:text-[9px] font-black">已收: {gameState.collected[PlayerId.AI_LEFT].length}</div>
            </div>
          </div>
          <div className="absolute top-6 right-6 flex flex-col items-center gap-2 z-30">
            <div className={`w-12 h-12 md:w-16 md:h-16 rounded-2xl border-2 bg-slate-900 flex items-center justify-center text-2xl md:text-3xl shadow-2xl transition-all duration-500 ${gameState.turn === PlayerId.AI_RIGHT ? 'border-emerald-500 ring-4 ring-emerald-500/20 scale-110' : 'border-white/10'}`}>
               {slots[PlayerId.AI_RIGHT].type === 'ai' ? '🤖' : '🧔'}
            </div>
            <div className="flex flex-col items-center gap-0.5 text-center">
               <span className="text-[10px] md:text-[11px] font-black text-slate-300 chinese-font">{gameState.aiNames[PlayerId.AI_RIGHT]} ({gameState.hands[PlayerId.AI_RIGHT].length})</span>
               <div className="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full text-[8px] md:text-[9px] font-black">已收: {gameState.collected[PlayerId.AI_RIGHT].length}</div>
            </div>
          </div>
          <div className="flex items-center justify-center gap-8 md:gap-24 z-20 w-full max-w-5xl px-10 scale-90 md:scale-100">
            {renderTableSlot(PlayerId.AI_LEFT)}
            {renderTableSlot(PlayerId.PLAYER)}
            {renderTableSlot(PlayerId.AI_RIGHT)}
          </div>
          <div className="absolute left-6 bottom-4 space-y-2 z-40 max-w-[220px] hidden md:block">
             <div className="px-4 py-1.5 bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-xl text-[10px] font-black">收牌: {gameState.collected[PlayerId.PLAYER].length}</div>
             {gameState.logs.map((log, i) => <div key={i} className={`text-[10px] px-3 py-2 rounded-xl bg-slate-900/70 border border-white/5 backdrop-blur-md animate-in slide-in-from-left ${i === 0 ? 'text-emerald-400 border-emerald-500/20 font-bold' : 'text-slate-500 opacity-60'}`}>{log}</div>)}
          </div>
          {gameState.phase === GamePhase.KOU_LE_DECISION && (
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-[150] flex items-center justify-center p-6 animate-in fade-in">
              <div className="bg-slate-900 border border-emerald-500/40 p-8 rounded-3xl max-w-sm w-full text-center shadow-2xl">
                <div className="text-3xl mb-4">⚖️</div>
                <h3 className="text-xl font-black text-emerald-500 chinese-font mb-2">“扣了”博弈中</h3>
                <p className="text-sm text-slate-400 mb-6">{gameState.kouLeInitiator === PlayerId.PLAYER ? '您发起了博弈，等待回复...' : `${gameState.aiNames[gameState.kouLeInitiator!]} 发起了博弈，您是否挑战？`}</p>
                {gameState.kouLeResponses[PlayerId.PLAYER] === null && gameState.kouLeInitiator !== PlayerId.PLAYER && (
                  <div className="flex gap-4">
                    <button onClick={() => isHost ? processKouLeResponse(PlayerId.PLAYER, 'agree') : sendToHost('ACTION_KOU_LE_RES', {playerId: PlayerId.PLAYER, response: 'agree'})} className="flex-1 py-4 bg-slate-800 hover:bg-slate-700 rounded-xl font-black transition-all">扣了(同意)</button>
                    <button onClick={() => isHost ? processKouLeResponse(PlayerId.PLAYER, 'challenge') : sendToHost('ACTION_KOU_LE_RES', {playerId: PlayerId.PLAYER, response: 'challenge'})} className="flex-1 py-4 bg-emerald-600 hover:bg-emerald-500 rounded-xl font-black transition-all">宣(挑战)</button>
                  </div>
                )}
                <div className="mt-6 space-y-1 text-left">
                  {Object.entries(gameState.kouLeResponses).map(([id, resp]) => resp && (
                    <div key={id} className="text-[10px] text-emerald-400/60 flex justify-between">
                      <span>{id === PlayerId.PLAYER ? '您' : gameState.aiNames[id]}</span>
                      <span className="font-bold">{resp === 'agree' ? '扣了' : '挑战'}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="h-44 md:h-64 bg-slate-900/95 border-t border-white/5 p-4 flex items-end justify-center relative z-40 overflow-visible">
           {gameState.phase === GamePhase.PLAYING && gameState.turn === PlayerId.PLAYER && gameState.table.length === 0 && (
              <button onClick={() => isHost ? processInitiateKouLe(PlayerId.PLAYER) : sendToHost('ACTION_KOU_LE_INIT', {playerId: PlayerId.PLAYER})} className="absolute top-[-50px] left-1/2 -translate-x-1/2 px-8 py-2 bg-orange-900/40 border border-orange-500/30 rounded-full text-orange-400 text-xs font-black hover:bg-orange-800 transition-all z-50 backdrop-blur-md">发起“扣了”？</button>
           )}
           <div className="flex-1 flex gap-2 justify-center pb-4 px-10 overflow-visible max-w-7xl">
             {playerHandSorted.map((c, i) => {
               const isSel = selectedCards.some(sc => sc.id === c.id);
               const isHovered = hoveredCardId === c.id;
               const zIndex = isHovered ? 1000 : (isSel ? 500 + i : 10 + i);
               return (
                 <div key={c.id} onMouseEnter={() => setHoveredCardId(c.id)} onMouseLeave={() => setHoveredCardId(null)} onClick={() => setSelectedCards(prev => isSel ? prev.filter(sc => sc.id !== c.id) : [...prev, c])}
                   className={`transition-all duration-300 cursor-pointer relative ${isSel ? '-translate-y-12 scale-110' : 'hover:-translate-y-8 hover:scale-105'}`}
                   style={{ marginLeft: i === 0 ? 0 : '-2.5rem', zIndex }}>
                   <div className={`${isSel || isHovered ? 'drop-shadow-[0_0_25px_rgba(16,185,129,0.8)]' : 'drop-shadow-lg'} scale-90 md:scale-100`}>
                    <PlayingCard card={c} />
                   </div>
                 </div>
               );
             })}
           </div>
        </div>
      </div>
      <div className="w-20 md:w-28 landscape:h-screen bg-slate-900 border-l border-white/10 flex flex-col items-center justify-center p-4 gap-4 md:gap-8 z-[100]">
        <button onClick={() => handleAction(false)} disabled={selectedCards.length === 0 || gameState.turn !== PlayerId.PLAYER}
          className={`w-full py-4 md:py-7 rounded-xl md:rounded-2xl font-black chinese-font transition-all text-base md:text-xl border border-white/5 ${selectedCards.length > 0 && gameState.turn === PlayerId.PLAYER ? 'bg-emerald-600 hover:bg-emerald-500 active:scale-90' : 'bg-slate-800 text-slate-600 opacity-30 cursor-not-allowed'}`}>
          {gameState.table.length === 0 ? '出' : '跟'}<br/>{gameState.table.length === 0 ? '牌' : '进'}
        </button>
        <button onClick={() => handleAction(true)} disabled={selectedCards.length === 0 || gameState.turn !== PlayerId.PLAYER || !gameState.table.length}
          className={`w-full py-4 md:py-7 rounded-xl md:rounded-2xl font-black chinese-font transition-all text-base md:text-xl border border-white/5 ${selectedCards.length > 0 && gameState.turn === PlayerId.PLAYER ? 'bg-orange-700 hover:bg-orange-600 active:scale-90' : 'bg-slate-800 text-slate-600 opacity-30 cursor-not-allowed'}`}>
          扣<br/>牌
        </button>
        <div className="h-px w-full bg-white/5"></div>
        <button onClick={() => setSelectedCards([])} className="w-full py-2 md:py-4 bg-slate-800 rounded-xl text-[10px] md:text-xs font-black text-slate-400 active:scale-90 transition-all">清 空</button>
      </div>
      {gameState.phase === GamePhase.SETTLEMENT && (
        <div className="absolute inset-0 z-[300] bg-slate-950/98 flex items-center justify-center p-4 backdrop-blur-3xl animate-in zoom-in">
          <div className="max-w-md w-full bg-slate-900 border border-emerald-500/40 p-10 rounded-[40px] shadow-2xl text-center">
            <h2 className="text-4xl font-black chinese-font text-emerald-500 mb-10 tracking-widest">对局结算</h2>
            <div className="space-y-4 mb-10">
              {settlementData.map(res => (
                <div key={res.id} className={`flex justify-between items-center p-5 bg-white/5 rounded-2xl border transition-all ${res.netGain < 0 ? 'border-red-500/30 opacity-70' : (res.netGain > 0 ? 'border-emerald-500/50 scale-105 shadow-[0_0_20px_rgba(16,185,129,0.1)]' : 'border-white/5')}`}>
                  <span className="font-black text-lg chinese-font">{res.id === PlayerId.PLAYER ? '您自己' : gameState.aiNames[res.id]}</span>
                  <div className="flex flex-col items-end">
                     <span className={`font-black px-3 py-1 rounded-lg text-sm ${res.coins > 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>{res.level} ({res.cards}张)</span>
                     <span className={`text-base font-black mt-1 ${res.netGain > 0 ? 'text-yellow-500' : (res.netGain < 0 ? 'text-red-500' : 'text-slate-400')}`}>
                       {res.netGain > 0 ? `+${res.netGain}` : res.netGain} 🪙
                     </span>
                     {res.isChallengerFailed && <span className="text-[10px] text-red-400 font-bold uppercase tracking-tighter">⚠️ “宣” 失败扣除</span>}
                  </div>
                </div>
              ))}
            </div>
            {isHost && (
              <button onClick={() => {setGameState(prev => ({...prev, phase: GamePhase.WAITING})); broadcast('SYNC_STATE', {...gameState, phase: GamePhase.WAITING});}} className="w-full py-5 bg-emerald-600 hover:bg-emerald-500 rounded-2xl font-black text-xl shadow-2xl transition-all chinese-font active:scale-95">整 顿 再 战</button>
            )}
            <button onClick={() => window.location.href = window.location.origin} className="w-full mt-4 py-3 bg-slate-800 text-slate-400 rounded-xl text-xs font-black transition-all hover:bg-slate-700">返回大厅</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
