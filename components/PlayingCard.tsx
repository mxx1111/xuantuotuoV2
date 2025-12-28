
import React from 'react';
import { Card } from '../types';

interface PlayingCardProps {
  card: Card;
  size?: 'normal' | 'small' | 'mini';
  isBack?: boolean;
}

const PlayingCard: React.FC<PlayingCardProps> = ({ card, size = 'normal', isBack = false }) => {
  const getSuitColor = () => {
    if (card.name === '大王') return 'text-red-600';
    if (card.name === '小王') return 'text-slate-900';
    if (card.suit === '♥' || card.suit === '♦') return 'text-red-600';
    return 'text-slate-900';
  };

  const suitColor = getSuitColor();

  // 尺寸定义
  const dimensions = {
    normal: 'w-20 h-32 md:w-24 md:h-36',
    small: 'w-14 h-20 md:w-16 md:h-24',
    mini: 'w-10 h-14'
  };

  if (isBack) {
    return (
      <div className={`relative rounded-lg shadow-xl border-2 border-slate-700 bg-slate-800 flex flex-col items-center justify-center overflow-hidden transform transition-all duration-300 ${dimensions[size]}`}>
        <div className="absolute inset-1 border border-slate-600 rounded-md"></div>
        <div className={size === 'mini' ? 'text-lg opacity-20 rotate-45' : 'text-2xl opacity-20 rotate-45'}>宣</div>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-slate-700/50 via-transparent to-transparent"></div>
      </div>
    );
  }

  const baseClasses = `
    relative rounded-lg shadow-xl flex flex-col border border-slate-300
    bg-white select-none transition-all duration-300 transform
    ${dimensions[size]}
  `;

  // 字体大小定义
  const fonts = {
    normal: { corner: 'text-xs', main: 'text-2xl md:text-3xl', label: 'text-lg md:text-xl' },
    small: { corner: 'text-[9px]', main: 'text-lg md:text-xl', label: 'text-xs md:text-sm' },
    mini: { corner: 'text-[7px]', main: 'text-[12px]', label: 'text-[8px]' }
  };

  const f = fonts[size];

  return (
    <div className={baseClasses}>
      <div className={`absolute top-0.5 left-0.5 flex flex-col items-center leading-none ${suitColor} ${f.corner} font-black`}>
        <span>{card.value === 'Joker' ? (card.name === '大王' ? 'RJ' : 'SJ') : card.value}</span>
        <span className="scale-75 origin-top">{card.suit}</span>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center relative overflow-hidden">
        <div className={`absolute inset-0 flex items-center justify-center opacity-5 ${suitColor} ${size === 'mini' ? 'scale-[1.5]' : (size === 'small' ? 'scale-[1.8]' : 'scale-[2.5]')}`}>
           {card.suit}
        </div>
        <div className={`z-10 flex flex-col items-center ${suitColor} leading-tight`}>
           <span className={`chinese-font font-black ${f.label}`}>{card.name}</span>
           <span className={`${f.main} font-bold`}>{card.suit}</span>
        </div>
      </div>

      <div className={`absolute bottom-0.5 right-0.5 flex flex-col items-center rotate-180 leading-none ${suitColor} ${f.corner} font-black`}>
        <span>{card.value === 'Joker' ? (card.name === '大王' ? 'RJ' : 'SJ') : card.value}</span>
        <span className="scale-75 origin-top">{card.suit}</span>
      </div>
      <div className="absolute inset-0 rounded-lg pointer-events-none bg-gradient-to-tr from-transparent via-white/10 to-white/20"></div>
    </div>
  );
};

export default PlayingCard;
