/** @type {import('tailwindcss').Config} */
module.exports = {
  // 采用 class 策略，使我们可以通过在 html 上添加/移除 `dark` 类来切换主题
  darkMode: 'class',
  content: [
    './index.html',
    './App.tsx',
    './index.tsx',
    './constants.tsx',
    './gameLogic.ts',
    './types.ts',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        serif: ['"Noto Serif SC"', 'serif'],
        sans: ['Inter', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
