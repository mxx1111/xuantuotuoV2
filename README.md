<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1NILrCrsgPLgXVSOJXE-b5M_YbngDtbbH

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## 部署 peerjs/peerjs-server 服务

首先，将 docker-compose.peerjs.yml 文件上传到服务器的制定位置

然后执行命令：

```
docker compose -f docker-compose.peerjs.yml up -d
```

最后会数出来：

 ```
WARN[0000] /opt/1panel/www/sites/xtt.88688.team/index/docker-compose.peerjs.yml: the attribute `version` is obsolete, it will be ignored, please remove it to avoid potential confusion 
[+] Running 10/10
 ✔ peerjs Pulled                                                                                       112.9s 
   ✔ c926b61bad3b Pull complete                                                                         10.1s 
   ✔ bc7465dc4da3 Pull complete                                                                         88.5s 
   ✔ de7b2bf3cf64 Pull complete                                                                         88.6s 
   ✔ 3604fe7c8f3c Pull complete                                                                         88.6s 
   ✔ a5931e279558 Pull complete                                                                         88.7s 
   ✔ 4f4fb700ef54 Pull complete                                                                         88.7s 
   ✔ 0703893d05b4 Pull complete                                                                         88.7s 
   ✔ f50a72d391f4 Pull complete                                                                         89.6s 
   ✔ 08e72095c94d Pull complete                                                                         89.6s 
[+] Running 2/2
 ✔ Network index_default        Created                                                                  0.1s 
 ✔ Container xuantuotuo-peerjs  Started                                                                  0.7s 
root@10-10-5-29:/opt/1panel/www/sites/xtt.88688.team/index# 
```

第二，在 nginx中配置：

```
 server {
      listen 80;
      listen 443 ssl;
      server_name xtt.88688.team;
      # ...你原来的 static 配置保持不变...

      root /www/sites/xtt.88688.team/index/dist;

      # === 新增 PeerJS WebSocket 反向代理 ===
      location /peerjs/ {
          proxy_pass http://127.0.0.1:9809/peerjs/;

          proxy_http_version 1.1;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection "upgrade";

          proxy_set_header Host $host;
          proxy_set_header X-Real-IP $remote_addr;
          proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          proxy_set_header X-Forwarded-Proto $scheme;

          proxy_read_timeout 120s;
          proxy_send_timeout 120s;
          proxy_connect_timeout 10s;
      }
  }

  说明：

  - proxy_pass 的路径尾部保留 /peerjs/，与容器启动参数 --path /peerjs 一致。
  - Upgrade/Connection 头启用 WebSocket；X-Forwarded-* 让 PeerJS 感知真实 IP/协议，对我们在 docker-compose.peerjs.yml 里设置的 PROXIED=true 相匹配。
  - PeerJS 服务需监听 127.0.0.1:9809（或换成你的 Docker 网桥地址）；如果容器在另一台服务器，就把 proxy_pass 改成对应 IP。

  最后在游戏项目 .env 中把 PeerJS 配置指向这个同域路径：

  VITE_PEER_HOST=xtt.88688.team
  VITE_PEER_PORT=443
  VITE_PEER_PATH=/peerjs
  VITE_PEER_SECURE=true

  重载 Nginx (sudo nginx -s reload) 后，浏览器会走 wss://xtt.88688.team/peerjs 与容器通信，不再依赖外部 0.peerjs.com。
```

注意，停止服务和启动服务命令如下：

```
docker compose -f docker-compose.peerjs.yml down
  docker compose -f docker-compose.peerjs.yml up -d
```
