# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

**宣坨坨游戏 V2** - 这是山西吕梁柳林地区传统扑克牌游戏的现代化 H5 版本，使用 React + TypeScript 重构。

这是一个3人收牌策略类游戏，支持：
- 单人 vs AI 对战
- P2P 多人在线对战（通过 PeerJS）
- 完整的24张牌体系（卒马相尔曲曲 + 大小王）
- 星光币虚拟货币系统

## 技术栈

- **前端框架**: React 19.2.3
- **开发工具**: Vite 7.3.0 + TypeScript 5.7.3
- **样式方案**: Tailwind CSS 3 (CDN 加载)
- **P2P 通信**: PeerJS 1.5.2
- **字体**: Google Fonts (Noto Serif SC + Inter)
- **模块加载**: ES Modules + Import Maps

## 开发命令

```bash
# 安装依赖
npm install

# 启动开发服务器 (默认端口 5173)
npm run dev

# 生产构建
npm run build

# 预览构建产物
npm run preview
```

## 项目结构

```
xauntuotuoV2/
├── index.html          # 应用入口，包含 Tailwind 配置和动画样式
├── index.tsx           # React 应用挂载点
├── App.tsx             # 主应用组件，包含完整游戏 UI 和状态管理
├── gameLogic.ts        # 核心游戏逻辑和规则引擎
├── constants.tsx       # 游戏常量（卡牌定义、颜色、配置）
├── types.ts            # TypeScript 类型定义
├── components/         # React 组件目录
├── dist/               # 构建产物目录
├── vite.config.ts      # Vite 配置
└── package.json        # 项目依赖和脚本
```

## 核心文件说明

### App.tsx
- 包含完整的游戏 UI 和所有视图（菜单、游戏、结果）
- 使用 React Hooks 管理游戏状态
- 支持 AI 对战和 P2P 在线对战模式
- 实现了完整的动画系统（发牌、出牌、收牌）

### gameLogic.ts
- 游戏核心逻辑引擎
- 关键函数：
  - `createDeck()`: 创建24张牌组
  - `dealCards()`: 发牌逻辑
  - `isValidPlay()`: 验证出牌是否合法
  - `canBeat()`: 判断能否压制对方牌
  - `selectAIPlay()`: AI 自动选牌策略
  - `calculateGameResult()`: 结算胜负和星光币

### constants.tsx
- 卡牌定义: `CARDS` 数组，包含24张牌的名称、花色、数值、牌力
- 颜色常量: `CARD_COLORS` - 红黑两色的配色方案
- 游戏配置: 初始星光币、AI 难度等

### types.ts
- TypeScript 类型定义
- 核心类型: `Card`, `Player`, `GameState`, `ViewType`

## 游戏规则概要

### 牌力等级
红尔(24) > 黑尔(23) > 红相(22) > 黑相(21) > 红马(20) > 黑马(19) > 红卒(18) > 黑卒(17) > 红曲曲(16/15/14) > 黑曲曲(16/15/14) > 大王(13) > 小王(13)

### 收牌标准
- 不够: <9张，不得分
- 刚够: 9张，获得1星光币
- 五了: 15张，获得2星光币
- 此了: 18张，获得3星光币

### 特殊规则
- 对子：同数字同颜色才能组成对子
- 曲曲对：同色的 J、Q、K 任意组合
- 大小王对：特殊对子，与红尔对不分胜负

## 部署相关

### 构建产物
```bash
npm run build
# 构建产物位于 dist/ 目录
# 包含: index.html, assets/index-[hash].js, assets/index-[hash].css
```

### 线上部署 - CSP 配置问题

**重要提示**: 本项目在线上部署时可能遇到 Content Security Policy (CSP) 错误。

#### 问题原因
- `index.html` 中使用了 inline script 配置 Tailwind CSS
- `index.html` 中使用了 inline style 定义动画
- 加载了多个 CDN 外部资源（Tailwind、PeerJS、React ESM）

#### Nginx CSP 配置方案

在 Nginx 配置文件中添加以下 CSP 头（根据实际需求调整）：

**方案 1: 宽松配置（适合开发/测试环境）**
```nginx
location /xtt/v2/ {
    # 允许 inline 脚本和样式
    add_header Content-Security-Policy "
        default-src 'self';
        script-src 'self' 'unsafe-inline' 'unsafe-eval'
            https://unpkg.com
            https://cdn.tailwindcss.com
            https://esm.sh
            https://fonts.googleapis.com;
        style-src 'self' 'unsafe-inline'
            https://fonts.googleapis.com
            https://cdn.tailwindcss.com;
        font-src 'self'
            https://fonts.gstatic.com;
        connect-src 'self'
            wss:
            https:;
        img-src 'self'
            data:
            https:;
    " always;

    try_files $uri $uri/ /xtt/v2/index.html;
}
```

**方案 2: 中等安全配置（推荐）**
```nginx
location /xtt/v2/ {
    # 使用 nonce 或限制来源
    add_header Content-Security-Policy "
        default-src 'self';
        script-src 'self' 'unsafe-inline'
            https://unpkg.com
            https://cdn.tailwindcss.com
            https://esm.sh;
        style-src 'self' 'unsafe-inline'
            https://fonts.googleapis.com;
        font-src 'self'
            https://fonts.gstatic.com;
        connect-src 'self'
            wss://0.peerjs.com
            https://*.peerjs.com;
        img-src 'self' data:;
    " always;

    try_files $uri $uri/ /xtt/v2/index.html;
}
```

**方案 3: 完整 Nginx 配置示例**
```nginx
server {
    listen 80;
    server_name your-domain.com;

    # 静态文件根目录
    root /var/www/html;

    # 宣坨坨游戏 V2
    location /xtt/v2/ {
        alias /var/www/html/xauntuotuoV2/dist/;
        index index.html;

        # CSP 配置（推荐使用方案2）
        add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.tailwindcss.com https://esm.sh; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' wss: https:;" always;

        # 其他安全头
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-XSS-Protection "1; mode=block" always;

        # 缓存配置
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }

        try_files $uri $uri/ /xtt/v2/index.html;
    }
}
```

## 调试技巧

### 查看 CSP 错误
在浏览器开发者工具的 Console 中查看 CSP 违规报告，会显示被阻止的资源。

### 验证 Nginx 配置
```bash
# 测试配置文件语法
nginx -t

# 重新加载配置
nginx -s reload

# 查看错误日志
tail -f /var/log/nginx/error.log
```

## API 访问地址

- **开发环境**: `http://localhost:5173`
- **生产环境**: 根据实际部署路径

## Communication Guidelines

- 所有回答请使用中文
- 代码注释使用中文
- 在未允许的情况下，不要主动操作 git

## Coding Guidelines

- 遵循 React Hooks 最佳实践
- 使用 TypeScript 类型约束
- 保持组件函数式编程风格
- CSS 类名优先使用 Tailwind 工具类
- 游戏逻辑和 UI 逻辑分离
