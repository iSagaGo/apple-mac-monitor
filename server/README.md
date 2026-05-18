# Apple Mac Monitor Server

用于监控 Apple 中国翻新 Mac Studio 页面，展示 Web 仪表盘，并支持 Telegram / 腾讯云短信提醒。

## 本地运行

```powershell
cd "D:\codex\apple mac\server"
npm install
notepad .env
npm start
```

本地服务会自动读取 `server/.env`，不需要再手动设置 PowerShell `$env:` 变量。当前本地默认端口是 `8788`：

```text
http://127.0.0.1:8788
```

## 服务器部署 OpenCloudOS 9

更完整的腾讯云 OpenCloudOS 9 部署步骤见：

```text
..\docs\tencent-opencloudos9-deploy.md
```

```bash
sudo dnf update -y
sudo dnf install -y git docker
sudo systemctl enable --now docker
sudo mkdir -p /opt/apple-mac-monitor
```

把 `server/` 目录上传到 `/opt/apple-mac-monitor`，然后：

```bash
cd /opt/apple-mac-monitor
cp .env.example .env
openssl rand -hex 32
```

编辑 `.env`，至少设置：

```env
ADMIN_TOKEN=example_admin_token_value
LOCAL_SCRIPT_TOKEN=example_local_script_token_value
LOCAL_DEV_AUTH_DISABLED=false
PORT=8787
SMS_DRY_RUN=true
TG_NOTIFY_ENABLED=true
APPLE_LISTING_ENABLED=false
SCAN_INTERVAL_SECONDS=10
```

启动：

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8787/api/health
```

首次访问仪表盘：

```text
http://服务器IP:8787/?token=ADMIN_TOKEN
```

## Telegram 配置

1. 用 BotFather 创建 Bot，拿到 `TG_BOT_TOKEN`。
2. 让目标账号或群先给 bot 发一条消息；如果是群，把 bot 拉进群。
3. 获取 `TG_CHAT_ID`，然后写入 `.env`：

```env
TG_NOTIFY_ENABLED=true
TG_BOT_TOKEN=example_bot_token
TG_CHAT_ID=example_chat_id
TG_API_BASE_URL=https://api.telegram.org
TG_PROXY_ENABLED=false
TG_HTTP_PROXY_URL=
```

海外服务器通常保持 `TG_PROXY_ENABLED=false`。本地 Windows 如果 Node 不能直连 Telegram，但系统代理可用，可以设置：

```env
TG_PROXY_ENABLED=true
TG_HTTP_PROXY_URL=http://127.0.0.1:8800
```

如果使用的是兼容 Telegram Bot API 路径的反向代理网关，也可以改 `TG_API_BASE_URL`。

测试：

```bash
curl -X POST http://127.0.0.1:8787/api/telegram/test \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Apple Mac Monitor TG real test"}'
```

## 腾讯云短信配置

腾讯云短信必须先在控制台完成签名和模板审核。模板变量个数要和发送参数一一对应。

```env
SMS_DRY_RUN=false
TENCENT_SECRET_ID=你的SecretId
TENCENT_SECRET_KEY=example_secret_key
TENCENT_SMS_SDK_APP_ID=1400000000
TENCENT_SMS_SIGN_NAME=已审核短信签名
TENCENT_SMS_TEMPLATE_ID=已审核模板ID
TENCENT_SMS_PHONE_NUMBERS=+8613800000000
TENCENT_SMS_TEMPLATE_PARAMS={productLabel},{price},{productId}
TENCENT_SMS_ENDPOINT=https://sms.tencentcloudapi.com
TENCENT_SMS_REGION=
```

测试：

```bash
curl -X POST http://127.0.0.1:8787/api/sms/test \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"templateParams":["Mac Studio 512GB"]}'
```

## 常用命令

```bash
docker compose logs -f --tail=200
docker compose restart
docker compose exec apple-monitor npm run backup
docker compose exec apple-monitor npm run scan:once
```

SQLite 数据在 `./data/apple-monitor.sqlite`，备份会写入 `./data/backups/`。

## 当前默认监控

- 全局抓取页：`https://www.apple.com.cn/shop/refurbished/mac/mac-studio`
- 当前默认 `APPLE_LISTING_ENABLED=false`，暂时不抓全局页，只抓独立监控页；需要恢复全局抓取时改为 `true`。
- 独立监控页：`https://www.apple.com.cn/shop/product/g1cepch/a`
- 默认筛选：`Mac Studio + 512gb`
- 同一有货窗口不会重复 SMS/TG；售罄后再次有货会重新提醒。
