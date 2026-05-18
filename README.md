# Apple Mac refurbished stock monitor

This project has two deployment modes.

- Local Windows monitor: checks Apple China refurbished Mac product pages every 10 seconds. When a product becomes purchasable, it shows a Windows desktop notification, plays a beep, and opens the product page.
- Server monitor: `server/` runs a Web dashboard, SQLite persistence, deterministic Apple page parsing, dry-run SMS/TG event records, and a 10-second scheduler for Tencent Cloud/OpenCloudOS deployment.

## Local Windows Quick Start

双击启动本地强提醒监控：

```text
start-local-monitor.bat
```

这只启动 Windows 本地监控：桌面通知、蜂鸣、自动打开商品页。它不启动 Web Dashboard、不发送 Telegram、不发送短信。

常用本地监控脚本：

```text
start-local-monitor.bat
stop-local-monitor.bat
restart-local-monitor.bat
status-local-monitor.bat
```

双击启动本地 Web 服务，仅用于本机调试 Dashboard：

```text
start-local-server.bat
```

这个 bat 会启动 `server/` 的 Web Dashboard，并打开本地页面。如果 `.env` 开启了 TG/SMS，它会按服务器逻辑工作；正式运行时通常只在服务器上启动这一套。

安装开机自启：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-service.ps1
```

The installer tries to create a Windows Scheduled Task named `AppleMacStockMonitor`. If Windows denies that without elevation, it creates a current-user Startup shortcut instead. Either way, it starts the monitor now and starts it again whenever you log in.

## Useful commands

```powershell
.\status-monitor.ps1
.\stop-monitor.ps1
.\start-monitor.ps1
.\uninstall-service.ps1
```

判断本地监控是否在运行：

```text
status-local-monitor.bat
```

看到 `Process: running (PID=...)` 就代表本地监听服务正在运行。最新扫描记录在 `logs\monitor-YYYY-MM-DD.log`。

## Configuration

Edit `config\products.json` to add more products or tune behavior.

- `intervalSeconds`: polling interval, currently `10`.
- `repeatAlertAfterSeconds`: repeats the alert at most once per product per 60 seconds while the product remains available.
- `notifications.openBrowser`: opens the product page when available.
- Local Windows monitor only checks product URLs in `products`; it does not run the global refurbished listing scan.

Logs are written to `logs\monitor-YYYY-MM-DD.log`.

## Server Dashboard

See `server\README.md`.

腾讯云 OpenCloudOS 9 部署说明见 `docs\tencent-opencloudos9-deploy.md`。
