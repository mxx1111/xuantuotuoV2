
import { Card, Play, PlayerId, Color, RewardLevel } from './types';
import { createDeck } from './constants';

export const calculatePlayStrength = (cards: Card[]): { type: Play['type']; strength: number } => {
  if (cards.length === 0) return { type: 'discard', strength: -1 };
  if (cards.length === 1) {
    return { type: 'single', strength: cards[0].strength };
  }
  
  if (cards.length === 2) {
    const [c1, c2] = cards;
    if ((c1.name === '大王' && c2.name === '小王') || (c2.name === '大王' && c1.name === '小王')) {
      return { type: 'pair', strength: 125 };
    }
    if (c1.name === '尔' && c2.name === '尔' && c1.color === 'red' && c2.color === 'red') {
      return { type: 'pair', strength: 125 };
    }
    const isQuQuMix = c1.name === '曲' && c2.name === '曲' && c1.color === c2.color;
    const isSameValueColor = c1.name === c2.name && c1.color === c2.color && c1.name !== '曲';
    
    if (isQuQuMix || isSameValueColor) {
      return { type: 'pair', strength: Math.max(c1.strength, c2.strength) + 100 };
    }
  }

  if (cards.length === 3) {
    const allQuQu = cards.every(c => c.name === '曲');
    const allSameColor = cards.every(c => c.color === cards[0].color);
    if (allQuQu && allSameColor) {
      return { type: 'triple', strength: Math.max(...cards.map(c => c.strength)) + 200 };
    }
  }

  return { type: 'discard', strength: -1 };
};

export const getValidPlays = (hand: Card[], targetPlay: Play | null, currentMaxStr: number = -1): Card[][] => {
  if (!targetPlay) {
    const results: Card[][] = [];
    hand.forEach(c => results.push([c]));
    for (let i = 0; i < hand.length; i++) {
      for (let j = i + 1; j < hand.length; j++) {
        const s = calculatePlayStrength([hand[i], hand[j]]);
        if (s.type === 'pair') results.push([hand[i], hand[j]]);
      }
    }
    if (hand.length >= 3) {
      for (let i = 0; i < hand.length; i++) {
        for (let j = i + 1; j < hand.length; j++) {
          for (let k = j + 1; k < hand.length; k++) {
            const s = calculatePlayStrength([hand[i], hand[j], hand[k]]);
            if (s.type === 'triple') results.push([hand[i], hand[j], hand[k]]);
          }
        }
      }
    }
    return results;
  }

  const { type } = targetPlay;
  const valid: Card[][] = [];
  
  if (type === 'single') {
    hand.forEach(c => {
      if (c.strength > currentMaxStr) valid.push([c]);
    });
  } else if (type === 'pair') {
    for (let i = 0; i < hand.length; i++) {
      for (let j = i + 1; j < hand.length; j++) {
        const s = calculatePlayStrength([hand[i], hand[j]]);
        if (s.type === 'pair' && s.strength > currentMaxStr) {
          valid.push([hand[i], hand[j]]);
        }
      }
    }
  } else if (type === 'triple') {
    for (let i = 0; i < hand.length; i++) {
      for (let j = i + 1; j < hand.length; j++) {
        for (let k = j + 1; k < hand.length; k++) {
          const s = calculatePlayStrength([hand[i], hand[j], hand[k]]);
          if (s.type === 'triple' && s.strength > currentMaxStr) {
            valid.push([hand[i], hand[j], hand[k]]);
          }
        }
      }
    }
  }

  return valid;
};

// Heuristic hint selection that prioritizes winning and common human strategies
export const suggestHintPlay = (
  hand: Card[],
  targetPlay: Play | null,
  currentMaxStr: number,
  collectedCount: number,
  table: Play[],
  roundHistory: Play[][],
  myCollected?: Card[]
): Card[] => {
  const valid = getValidPlays(hand, targetPlay, currentMaxStr);
  if (valid.length === 0) return [];

  const strength = (cards: Card[]) => calculatePlayStrength(cards).strength;
  const isTripleQuSameColor = (cards: Card[]) =>
    cards.length === 3 && cards.every(c => c.name === '曲') && cards.every(c => c.color === cards[0].color);
  const isSupremePair = (cards: Card[]) => {
    if (cards.length !== 2) return false;
    const [a, b] = cards;
    // 王对 或 红尔尔 视为“场上最大的对”
    const isWangPair = (a.name === '大王' && b.name === '小王') || (a.name === '小王' && b.name === '大王');
    const isRedErPair = a.name === '尔' && b.name === '尔' && a.color === 'red' && b.color === 'red';
    return isWangPair || isRedErPair || strength(cards) >= 125;
  };

  // 响应出牌：选能赢的最小即可（保留实力）
  if (targetPlay) {
    // 优先同色三曲三：若本轮要打三张
    if (targetPlay.type === 'triple') {
      const bestTripleQu = valid.filter(isTripleQuSameColor).sort((a, b) => strength(a) - strength(b))[0];
      if (bestTripleQu) return bestTripleQu;
    }
    return valid.slice().sort((a, b) => strength(a) - strength(b))[0];
  }

  // 首家出牌：
  // 计算“可见”牌集合，用于判断更强对是否仍可能存在
  const fullDeck = createDeck();
  const seen = new Set<string>();
  const pushSeen = (cards: Card[]) => {
    (cards || []).forEach(c => { if (c && typeof c.id === 'string' && !c.id.startsWith('hidden-')) seen.add(c.id); });
  };
  pushSeen(hand);
  (table || []).forEach(p => pushSeen(p.cards));
  (roundHistory || []).forEach(trick => trick.forEach(p => pushSeen(p.cards)));
  if (myCollected) pushSeen(myCollected);

  const unknown = new Set(fullDeck.map(c => c.id).filter(id => !seen.has(id)));
  const hasUnknown = (ids: string[]) => ids.every(id => unknown.has(id));

  const triples = valid.filter(v => v.length === 3).sort((a, b) => strength(b) - strength(a));
  const pairs = valid.filter(v => v.length === 2).sort((a, b) => strength(b) - strength(a));
  const singles = valid.filter(v => v.length === 1).sort((a, b) => a[0].strength - b[0].strength);

  // 规则2：有三个同色“曲曲曲”优先
  const tripleQu = triples.find(isTripleQuSameColor);
  if (tripleQu) return tripleQu;

  // 规则3：若有“最大的对”
  const topPair = pairs[0];
  if (topPair && isSupremePair(topPair)) {
    // 风险评估：是否仍可能存在更强的对（王对、红尔尔）
    const strongerPairStillPossible = (() => {
      // 自身就是王对或红尔尔时，不存在更强
      if (isSupremePair(topPair) && strength(topPair) >= 125) return false;
      const kingsPossible = hasUnknown(['bj','sj']);
      // 红尔对可能性：需要两张红尔都未见到
      const redErPossible = hasUnknown(['r_e1','r_e2']);
      // 若自己手里含有红尔单张，会在 seen 中，不会判定为可能
      return kingsPossible || redErPossible;
    })();

    if (collectedCount >= 3 && !strongerPairStillPossible) return topPair; // 有利时打开局面
    // 尚未收牌或风险较大：先出最小单张试探
    if (singles.length > 0) return singles[0];
    return topPair;
  }

  // 规则4：整体不大时更稳妥：出最小单张；若没有单张可出，出最小对子
  if (singles.length > 0) {
    // 简单利好评估：若最小单张过小（<20），且有对子可用，优先出最小对子，减少立刻被抢的概率
    const minSingle = singles[0];
    if (minSingle[0].strength < 20 && pairs.length > 0) {
      return pairs[pairs.length - 1]; // 最小对子（因为 pairs 已按降序）
    }
    return minSingle;
  }
  if (pairs.length > 0) return pairs[pairs.length - 1];
  return triples[triples.length - 1] || valid[0];
};

// 选择用于“扣牌”的卡组：尽量丢弃与胜利不相关或最小的单牌，避免破坏关键组合；必要时才打散非关键对子/三张
export const suggestDiscard = (hand: Card[], count: number): Card[] => {
  const byStrengthAsc = (a: Card, b: Card) => a.strength - b.strength;
  const handSorted = [...hand].sort(byStrengthAsc);

  // 找出所有可组成对子/三张的组合
  const allCombos = getValidPlays(hand, null);
  const pairs = allCombos.filter(c => c.length === 2);
  const triples = allCombos.filter(c => c.length === 3);

  const strength = (cards: Card[]) => calculatePlayStrength(cards).strength;
  const isTripleQuSameColor = (cards: Card[]) =>
    cards.length === 3 && cards.every(c => c.name === '曲') && cards.every(c => c.color === cards[0].color);
  const isSupremePair = (cards: Card[]) => {
    if (cards.length !== 2) return false;
    const [a, b] = cards;
    const isWangPair = (a.name === '大王' && b.name === '小王') || (a.name === '小王' && b.name === '大王');
    const isRedErPair = a.name === '尔' && b.name === '尔' && a.color === 'red' && b.color === 'red';
    return isWangPair || isRedErPair || strength(cards) >= 125;
  };

  // 标记哪些牌参与任何对子/三张（潜在关键）
  const involved = new Set<string>();
  [...pairs, ...triples].forEach(g => g.forEach(c => involved.add(c.id)));
  const singles = handSorted.filter(c => !involved.has(c.id));

  const pick: Card[] = [];

  // 1) 优先丢弃最小的单牌
  for (const c of singles) {
    if (pick.length < count) pick.push(c);
  }
  if (pick.length >= count) return pick.slice(0, count);

  // 2) 避免破坏“同色三曲三”与“最大对子”；保留一对最小对子作为残局资源
  const tripleQuList = triples.filter(isTripleQuSameColor);
  const protectedIds = new Set<string>();
  tripleQuList.forEach(g => g.forEach(c => protectedIds.add(c.id)));

  // 找到所有对子，计算强度，确定要“保留”的最小对子 + 所有“最大对子”
  const pairsWithScore = pairs.map(p => ({ cards: p, score: strength(p), supreme: isSupremePair(p) }));
  pairsWithScore.sort((a, b) => a.score - b.score); // 从小到大
  const reserveSmallPair = pairsWithScore[0]?.cards || [];
  reserveSmallPair.forEach(c => protectedIds.add(c.id));
  pairsWithScore.filter(p => p.supreme).forEach(p => p.cards.forEach(c => protectedIds.add(c.id)));

  // 3) 若仍需丢牌：尽量从“非关键对子/三张”里拿，优先拿最小的，且尽量只拿所需数量
  const takeFromGroup = (groups: Card[][]) => {
    for (const g of groups) {
      const usable = g.filter(c => !protectedIds.has(c.id));
      for (const c of usable.sort(byStrengthAsc)) {
        if (pick.length < count) pick.push(c);
      }
      if (pick.length >= count) break;
    }
  };

  // 非关键的对子（从小到大）
  const nonKeyPairs = pairsWithScore
    .filter(p => !p.supreme && p.cards !== reserveSmallPair)
    .map(p => p.cards);
  takeFromGroup(nonKeyPairs);
  if (pick.length >= count) return pick.slice(0, count);

  // 非关键三张（非同色三曲三）
  const nonKeyTriples = triples.filter(t => !isTripleQuSameColor(t));
  takeFromGroup(nonKeyTriples);
  if (pick.length >= count) return pick.slice(0, count);

  // 4) 实在不够：从受保护组中拿最小的（极少发生）
  const fallback = handSorted.filter(c => !pick.some(pc => pc.id === c.id));
  for (const c of fallback) {
    if (pick.length < count) pick.push(c);
  }
  return pick.slice(0, count);
};

export const aiDecidePlay = (
  hand: Card[],
  targetPlay: Play | null,
  currentMaxStr: number,
  collectedCount: number,
  table: Play[],
  roundHistory: Play[][]
): Card[] => {
  // 当需要跟牌：选择能赢的最小
  const validOptions = getValidPlays(hand, targetPlay, currentMaxStr);
  if (targetPlay) {
    if (validOptions.length === 0) {
      const count = targetPlay.cards.length;
      return suggestDiscard(hand, count);
    }
    return validOptions.slice().sort((a,b) => calculatePlayStrength(a).strength - calculatePlayStrength(b).strength)[0];
  }

  // 首出：与提示保持一致（风险感知）
  return suggestHintPlay(hand, null, -1, collectedCount, table, roundHistory);
};

/**
 * AI 决策博弈行为
 * @param hand 手牌
 * @param currentGrabMultiplier 当前全局抢牌倍数
 * @param grabberId 当前抢牌者ID
 */
export const aiDecideBet = (hand: Card[], currentGrabMultiplier: number, grabberId: PlayerId | null): { multiplier: number; grab: boolean } => {
  const topCardsCount = hand.filter(c => c.strength >= 22).length; 
  const pairCount = getValidPlays(hand, null).filter(p => p.length === 2).length;
  const tripleCount = getValidPlays(hand, null).filter(p => p.length === 3).length;

  let score = topCardsCount * 2 + pairCount + tripleCount * 3;
  
  // 抢收牌决策
  let wantGrab = false;
  if (score >= 8) wantGrab = true;
  else if (score >= 5 && Math.random() > 0.6) wantGrab = true;

  // 如果已经有人抢了，AI 只有在分高时才“顶抢”
  if (grabberId !== null && wantGrab) {
    if (score < 10) wantGrab = false; 
  }

  // 加倍决策
  let multiplier = 1;
  if (score >= 12) multiplier = 4;
  else if (score >= 6) multiplier = 2;

  return { multiplier, grab: wantGrab };
};

/**
 * “宣”的目标：基于当前已收牌数，承诺把档位升到下一档
 * - 不够(<9) -> 目标刚够(>=9)
 * - 刚够(9-14) -> 目标五了(>=15)
 * - 五了(15-17) -> 目标此了(>=18)
 * - 此了(>=18) -> 仍为此了(>=18)
 */
export const getKouLeChallengeTarget = (collectedCount: number): { targetCollected: number; targetLevel: RewardLevel } => {
  if (collectedCount < 9) return { targetCollected: 9, targetLevel: RewardLevel.GANG_GOU };
  if (collectedCount < 15) return { targetCollected: 15, targetLevel: RewardLevel.WU_LE };
  return { targetCollected: 18, targetLevel: RewardLevel.CI_LE };
};

export const aiEvaluateKouLe = (hand: Card[], collectedCount: number): 'agree' | 'challenge' => {
  const topCardsCount = hand.filter(c => c.strength >= 22).length;
  const pairCount = getValidPlays(hand, null).filter(p => p.length === 2).length;
  const tripleCount = getValidPlays(hand, null).filter(p => p.length === 3).length;
  
  const { targetCollected } = getKouLeChallengeTarget(collectedCount);
  const need = Math.max(0, targetCollected - collectedCount);
  if (need <= 0) return 'agree';

  const score = topCardsCount * 2 + pairCount + tripleCount * 3;
  // 离目标越近，越敢宣；离得越远，需要更强手牌
  const threshold = need <= 3 ? 4 : need <= 6 ? 6 : 8;
  return score >= threshold ? 'challenge' : 'agree';
};

export const checkNoXiang = (hand: Card[]): boolean => {
  const targets = ['尔', '相'];
  return !hand.some(c => targets.includes(c.name));
};

export const getRewardInfo = (collectedCount: number): { level: RewardLevel; coins: number } => {
  if (collectedCount >= 18) return { level: RewardLevel.CI_LE, coins: 3 };
  if (collectedCount >= 15) return { level: RewardLevel.WU_LE, coins: 2 };
  if (collectedCount >= 9) return { level: RewardLevel.GANG_GOU, coins: 1 };
  return { level: RewardLevel.BU_GOU, coins: 0 };
};
