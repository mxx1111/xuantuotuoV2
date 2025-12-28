
import { Card, Play, PlayerId, Color, RewardLevel } from './types';

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

export const aiDecidePlay = (hand: Card[], targetPlay: Play | null, currentMaxStr: number, collectedCount: number): Card[] => {
  const validOptions = getValidPlays(hand, targetPlay, currentMaxStr);
  if (targetPlay && validOptions.length === 0) {
    const count = targetPlay.cards.length;
    return [...hand].sort((a, b) => a.strength - b.strength).slice(0, count);
  }

  if (!targetPlay) {
    const needTo9 = Math.max(0, 9 - collectedCount);
    const triples = validOptions.filter(opt => opt.length === 3);
    const pairs = validOptions.filter(opt => opt.length === 2);
    const strongPairs = pairs.filter(p => calculatePlayStrength(p).strength >= 120);

    if (needTo9 > 3 && triples.length > 0) return triples[0];
    if (strongPairs.length > 0) return strongPairs.sort((a,b) => calculatePlayStrength(b).strength - calculatePlayStrength(a).strength)[0];
    if (collectedCount >= 15) {
      const singles = validOptions.filter(opt => opt.length === 1);
      return singles.sort((a,b) => a[0].strength - b[0].strength)[0];
    }
    if (pairs.length > 0) return pairs[0];
    return validOptions.sort((a,b) => a[0].strength - b[0].strength)[0];
  }

  validOptions.sort((a,b) => calculatePlayStrength(a).strength - calculatePlayStrength(b).strength);
  return validOptions[0];
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

export const aiEvaluateKouLe = (hand: Card[], collectedCount: number): 'agree' | 'challenge' => {
  const topCardsCount = hand.filter(c => c.strength >= 22).length;
  const pairCount = getValidPlays(hand, null).filter(p => p.length === 2).length;
  
  if (topCardsCount >= 2 || (collectedCount >= 6 && pairCount >= 2) || collectedCount >= 9) {
    return 'challenge';
  }
  return 'agree';
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
