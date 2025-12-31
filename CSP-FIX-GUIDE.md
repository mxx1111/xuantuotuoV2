# CSP 问题快速修复指南

## 问题现象

在浏览器控制台看到类似以下错误：
```
Content Security Policy: 页面的设置阻止了一个资源的加载
Refused to execute inline script because it violates CSP directive
Refused to apply inline style because it violates CSP directive
```

## 5分钟快速修复

### 步骤 1: 找到 Nginx 配置文件

常见位置：
```bash
# CentOS/RHEL
/etc/nginx/nginx.conf
/etc/nginx/conf.d/default.conf

# Ubuntu/Debian
/etc/nginx/sites-available/default
/etc/nginx/sites-enabled/default

# 查找配置文件
nginx -t
```

### 步骤 2: 添加 CSP 配置

在您的 `location` 块中添加以下配置（找到宣坨坨游戏对应的 location）：

**最简单的修复（推荐）：**
```nginx
location /xtt/v2/ {
    # 您现有的配置...

    # 添加这一行即可修复 CSP 问题
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.tailwindcss.com https://esm.sh; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' wss: https:; img-src 'self' data:;" always;

    # 您现有的其他配置...
}
```

### 步骤 3: 测试并重新加载配置

```bash
# 测试配置文件语法
sudo nginx -t

# 如果提示 "syntax is ok" 和 "test is successful"，则重新加载
sudo nginx -s reload

# 或者重启 Nginx
sudo systemctl restart nginx
```

### 步骤 4: 验证修复

1. 清除浏览器缓存（Ctrl+Shift+Delete 或 Cmd+Shift+Delete）
2. 刷新页面（Ctrl+F5 或 Cmd+Shift+R）
3. 检查浏览器控制台，CSP 错误应该消失

---

## 详细配置方案

### 方案 A: 如果您使用的是根路径部署

```nginx
server {
    listen 80;
    server_name 88688.team;

    location / {
        root /var/www/html/xauntuotuoV2/dist;
        index index.html;

        # CSP 配置
        add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.tailwindcss.com https://esm.sh; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' wss: https:; img-src 'self' data:;" always;

        # SPA 路由支持
        try_files $uri $uri/ /index.html;
    }
}
```

### 方案 B: 如果您使用的是子路径部署（如 /xtt/v2/）

```nginx
server {
    listen 80;
    server_name 88688.team;

    location /xtt/v2/ {
        alias /var/www/html/xauntuotuoV2/dist/;
        index index.html;

        # CSP 配置
        add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.tailwindcss.com https://esm.sh; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' wss: https:; img-src 'self' data:;" always;

        # SPA 路由支持
        try_files $uri $uri/ /xtt/v2/index.html;
    }
}
```

### 方案 C: 如果您现有配置已经有 CSP 头

找到现有的 `add_header Content-Security-Policy` 行，替换为：

```nginx
# 注释掉或删除旧的 CSP 配置
# add_header Content-Security-Policy "..." always;

# 替换为新的配置
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.tailwindcss.com https://esm.sh; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' wss: https:; img-src 'self' data:;" always;
```

---

## CSP 配置解释

每个指令的含义：

| 指令 | 作用 | 为什么需要 |
|------|------|-----------|
| `default-src 'self'` | 默认只允许同源资源 | 基础安全策略 |
| `script-src 'self' 'unsafe-inline' https://unpkg.com ...` | 允许同源、inline 脚本和指定 CDN | 因为 index.html 中有 inline script 和 CDN 脚本 |
| `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com` | 允许同源、inline 样式和 Google 字体 | 因为 index.html 中有 inline style 和 Google Fonts |
| `font-src 'self' https://fonts.gstatic.com` | 允许同源和 Google 字体文件 | Noto Serif SC 和 Inter 字体来自 Google Fonts |
| `connect-src 'self' wss: https:` | 允许 WebSocket 和 HTTPS 连接 | PeerJS 需要 WebSocket 连接 |
| `img-src 'self' data:` | 允许同源图片和 data URI | 游戏中可能使用 base64 图片 |

---

## 故障排查

### 问题 1: 修改配置后仍然报错

**解决方法：**
1. 确认 Nginx 配置已重新加载：`sudo nginx -s reload`
2. 清除浏览器缓存（重要！）
3. 使用隐私模式/无痕模式重新访问
4. 检查浏览器控制台 Network 标签，查看响应头是否包含新的 CSP

### 问题 2: Nginx 配置测试失败

**可能原因：**
- CSP 字符串中有语法错误
- 引号不匹配
- 分号位置错误

**解决方法：**
```bash
# 查看详细错误信息
sudo nginx -t

# 检查配置文件中的引号和分号
# 确保使用双引号包裹整个 CSP 字符串
# 确保每行以分号结尾
```

### 问题 3: 某些资源仍然被阻止

**解决方法：**
1. 查看浏览器控制台，确认被阻止的资源 URL
2. 将该 URL 的域名添加到相应的 CSP 指令中
3. 例如，如果 `https://example.com/script.js` 被阻止，在 `script-src` 中添加 `https://example.com`

### 问题 4: 找不到 Nginx 配置文件

**解决方法：**
```bash
# 查找 Nginx 配置文件
sudo find /etc -name "nginx.conf"
sudo find /etc -name "*.conf" | grep nginx

# 查看 Nginx 主配置文件位置
nginx -V 2>&1 | grep "configure arguments" | grep -o "conf-path=[^ ]*"

# 查看当前生效的配置
sudo nginx -T
```

---

## 验证 CSP 配置是否生效

### 方法 1: 使用浏览器开发者工具

1. 打开浏览器开发者工具（F12）
2. 进入 **Network** 标签
3. 刷新页面
4. 点击主文档请求（通常是第一个 HTML 请求）
5. 查看 **Headers** -> **Response Headers**
6. 确认包含 `Content-Security-Policy` 头

### 方法 2: 使用 curl 命令

```bash
# 查看响应头
curl -I https://88688.team/xtt/v2/

# 只查看 CSP 头
curl -I https://88688.team/xtt/v2/ | grep -i "content-security-policy"
```

### 方法 3: 使用在线工具

访问 https://csp-evaluator.withgoogle.com/ 输入您的 CSP 配置进行验证。

---

## 临时禁用 CSP（仅用于调试）

如果您需要临时禁用 CSP 来确认问题确实是 CSP 引起的：

```nginx
# 方法 1: 注释掉 CSP 配置
# add_header Content-Security-Policy "..." always;

# 方法 2: 使用 Report-Only 模式（只报告不阻止）
add_header Content-Security-Policy-Report-Only "..." always;
```

**警告：** 禁用 CSP 会降低安全性，仅用于调试，调试完成后必须重新启用！

---

## 联系支持

如果以上方法都无法解决问题，请提供以下信息：

1. Nginx 版本：`nginx -v`
2. 操作系统：`uname -a`
3. 浏览器控制台的完整错误信息（截图）
4. Nginx 配置文件相关部分（去除敏感信息）
5. 访问的完整 URL

---

## 附录：完整可用配置示例

```nginx
server {
    listen 80;
    server_name 88688.team;

    root /var/www/html;
    index index.html;

    # 宣坨坨游戏 V2
    location /xtt/v2/ {
        alias /var/www/html/xauntuotuoV2/dist/;
        index index.html;

        # CSP 配置 - 修复 inline script/style 问题
        add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.tailwindcss.com https://esm.sh; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' wss: https:; img-src 'self' data:;" always;

        # 其他安全头
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-XSS-Protection "1; mode=block" always;

        # SPA 路由支持
        try_files $uri $uri/ /xtt/v2/index.html;

        # 静态资源缓存
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
    }

    # 日志
    access_log /var/log/nginx/access.log;
    error_log /var/log/nginx/error.log;
}
```

**使用此配置的步骤：**
1. 复制上面的配置到您的 Nginx 配置文件
2. 修改 `server_name` 为您的域名
3. 修改 `alias` 路径为您的实际部署路径
4. 测试：`sudo nginx -t`
5. 重新加载：`sudo nginx -s reload`
6. 访问：`http://88688.team/xtt/v2/`
