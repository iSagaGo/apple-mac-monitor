# 腾讯云 OpenCloudOS 9 部署说明

本文档用于把 `server/` 部署到腾讯云 OpenCloudOS 9。服务器侧负责 Web 页面、SQLite 持久化、10 秒扫描、Telegram 提醒和腾讯云短信提醒。本地 Windows 的强制弹窗、蜂鸣、自动打开商品页仍由本地脚本负责。

## 1. 部署边界

- 服务器部署：运行 `server/`，提供 Web Dashboard、定时扫描、TG/SMS 推送、SQLite 数据保存。
- 本地部署：运行 Windows 脚本，处理强制弹窗、蜂鸣、自动打开商品页。
- 当前暂不处理 HTTPS / 反向代理；如需公网访问，请先在腾讯云安全组只放行你实际使用的端口。

## 2. 服务器准备

登录服务器后执行：

```bash
sudo dnf update -y
sudo dnf install -y git docker
sudo systemctl enable --now docker
docker --version
```

如果系统没有 `docker compose` 命令，再尝试安装 Compose 插件：

```bash
sudo dnf install -y docker-compose-plugin || sudo dnf install -y docker-compose
docker compose version || docker-compose version
```

创建部署目录：

```bash
sudo mkdir -p /opt/apple-mac-monitor
sudo chown -R "$USER":"$USER" /opt/apple-mac-monitor
```

## 3. 上传代码

推荐只上传 `server/` 目录内容到服务器的 `/opt/apple-mac-monitor`。

Windows 本地可以用 `scp`：

```powershell
scp -r "D:\codex\apple mac\server\*" root@你的服务器IP:/opt/apple-mac-monitor/
```

如果使用 Git 仓库，也可以在服务器上 `git clone` 后进入 `server/` 目录。不要把本地真实 `.env`、`data/`、`logs/`、`node_modules/` 当作部署依赖上传；服务器应单独配置自己的 `.env`。

## 4. 配置 .env

在服务器上执行：

```bash
cd /opt/apple-mac-monitor
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
nano .env
```

至少确认这些配置：

```env
ADMIN_TOKEN=example_admin_token_value
LOCAL_SCRIPT_TOKEN=example_local_script_token_value
LOCAL_DEV_AUTH_DISABLED=false
PORT=8787
DATA_DIR=/app/data

APPLE_LISTING_URLS=https://www.apple.com.cn/shop/refurbished/mac/mac-studio
APPLE_LISTING_ENABLED=false
APPLE_MANUAL_URLS=https://www.apple.com.cn/shop/product/g1cepch/a,https://www.apple.com.cn/shop/product/g1ce8ch/a

SCHEDULER_ENABLED=true
SCAN_INTERVAL_SECONDS=10

ALERT_RULE_ID=mac-studio-512gb
ALERT_DISABLED=false
ALERT_MODEL=Mac Studio
ALERT_MEMORY=512gb

TG_NOTIFY_ENABLED=true
TG_PROXY_ENABLED=false
TG_API_BASE_URL=https://api.telegram.org
TG_BOT_TOKEN=example_bot_token
TG_CHAT_ID=example_chat_id

SMS_DRY_RUN=true
```

说明：

- 海外服务器通常保持 `TG_PROXY_ENABLED=false`。
- 腾讯云短信审核完成前，先保持 `SMS_DRY_RUN=true`。
- `APPLE_LISTING_ENABLED=false` 表示暂时禁用全局抓取页，只扫描独立监控页面；后续要恢复全局抓取时改成 `true`。
- `APPLE_MANUAL_URLS` 用英文逗号分隔多条独立监控页面。
- Web 页面里保存的扫描来源和筛选规则会进入 SQLite，不会只存在浏览器缓存。

## 5. 启动服务

```bash
cd /opt/apple-mac-monitor
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:8787/api/health
```

健康检查正常时会返回类似：

```json
{"ok":true,"now":"2026-05-19T00:00:00.000+08:00"}
```

访问页面：

```text
http://你的服务器IP:8787/?token=你的ADMIN_TOKEN
```

第一次带 `token` 访问后，服务会写入浏览器会话 Cookie，之后可以直接访问：

```text
http://你的服务器IP:8787/
```

## 6. Telegram 测试

确保 bot 已经被拉进群，且群里有人发过一条消息。然后在服务器上测试：

```bash
ADMIN_TOKEN='example_admin_token_value'
curl -X POST http://127.0.0.1:8787/api/telegram/test \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Apple Mac Monitor TG real test"}'
```

如果接口返回 `dry_run`，通常是 `.env` 中 `TG_NOTIFY_ENABLED=false`、`TG_BOT_TOKEN` 为空或 `TG_CHAT_ID` 为空。

## 7. 腾讯云短信配置

短信必须先在腾讯云短信控制台完成签名和模板审核。建议模板只放短字段，例如商品标签、价格、商品 ID；完整链接放 TG 和 Web 页面。

审核完成后修改 `.env`：

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

重启后测试：

```bash
docker compose restart
ADMIN_TOKEN='example_admin_token_value'
curl -X POST http://127.0.0.1:8787/api/sms/test \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"templateParams":["Mac Studio 512GB","RMB 99999","G1CEPCH/A"]}'
```

## 8. 常用运维命令

```bash
cd /opt/apple-mac-monitor
docker compose logs -f --tail=200
docker compose restart
docker compose exec apple-monitor npm run scan:once
docker compose exec apple-monitor npm run backup
docker compose down
```

SQLite 数据库在：

```text
/opt/apple-mac-monitor/data/apple-monitor.sqlite
```

备份文件在：

```text
/opt/apple-mac-monitor/data/backups/
```

## 9. 更新部署

上传新代码后执行：

```bash
cd /opt/apple-mac-monitor
docker compose exec apple-monitor npm run backup
docker compose up -d --build
docker compose logs -f --tail=100
```

更新前先备份 SQLite。不要删除 `data/` 目录，除非你明确要清空历史状态、扫描来源、筛选规则和提醒记录。

## 10. 排查清单

- 页面打不开：检查腾讯云安全组是否放行 `PORT`，再检查 `docker compose ps`。
- API 返回 `unauthorized`：用 `http://服务器IP:PORT/?token=ADMIN_TOKEN` 重新登录。
- TG 不发：检查 bot 是否在群里、`TG_CHAT_ID` 是否正确、海外服务器是否能访问 `https://api.telegram.org`。
- 短信不发：先确认模板和签名已审核，`SMS_DRY_RUN=false`，手机号使用 `+86` 前缀。
- 扫描太频繁：当前是 `SCAN_INTERVAL_SECONDS=10`，手动扫描接口另有限流，避免误点造成过高频请求。
- 重复提醒：同一有货窗口不会重复发 SMS/TG；售罄后再次有货会重新提醒。
