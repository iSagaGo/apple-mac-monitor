const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, maskSecret, parseEnvFileText } = require('../src/config');

test('loadConfig applies Apple scan defaults and canonical sources', () => {
  const config = loadConfig(
    {
      ADMIN_TOKEN: 'a'.repeat(32),
      LOCAL_SCRIPT_TOKEN: 'b'.repeat(32),
    },
    { envFile: false },
  );

  assert.equal(config.apple.listIntervalSeconds, 45);
  assert.equal(config.apple.detailIntervalSeconds, 15);
  assert.equal(config.apple.scanConcurrency, 2);
  assert.equal(config.apple.requestTimeoutMs, 15000);
  assert.equal(config.apple.listingEnabled, false);
  assert.deepEqual(config.apple.listingUrls, ['https://www.apple.com.cn/shop/refurbished/mac/mac-studio']);
  assert.deepEqual(config.apple.manualUrls, ['https://www.apple.com.cn/shop/product/g1cepch/a']);
});

test('loadConfig can re-enable global listing scans explicitly', () => {
  const config = loadConfig(
    {
      ADMIN_TOKEN: 'a'.repeat(32),
      LOCAL_SCRIPT_TOKEN: 'b'.repeat(32),
      APPLE_LISTING_ENABLED: 'true',
    },
    { envFile: false },
  );

  assert.equal(config.apple.listingEnabled, true);
});

test('loadConfig rejects short production tokens unless local auth is disabled', () => {
  assert.throws(
    () => loadConfig({ ADMIN_TOKEN: 'short', LOCAL_SCRIPT_TOKEN: 'also-short' }, { envFile: false }),
    /ADMIN_TOKEN/,
  );

  const config = loadConfig({ LOCAL_DEV_AUTH_DISABLED: 'true' }, { envFile: false });
  assert.equal(config.auth.localDevAuthDisabled, true);
});

test('parseEnvFileText reads dotenv values, quotes, and comments', () => {
  const parsed = parseEnvFileText(`
# Apple monitor config
PORT=8788
ALERT_MODEL="Mac Studio"
TG_CHAT_ID='987654321'
EMPTY_VALUE=
MALFORMED
  `);

  assert.deepEqual(parsed, {
    PORT: '8788',
    ALERT_MODEL: 'Mac Studio',
    TG_CHAT_ID: '987654321',
    EMPTY_VALUE: '',
  });
});

test('loadConfig reads .env files without PowerShell environment variables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-env-'));
  const envFilePath = path.join(dir, '.env');
  fs.writeFileSync(
    envFilePath,
    [
      'PORT=8788',
      `DATA_DIR=${path.join(dir, 'data')}`,
      `ADMIN_TOKEN=${'c'.repeat(32)}`,
      `LOCAL_SCRIPT_TOKEN=${'d'.repeat(32)}`,
      'LOCAL_DEV_AUTH_DISABLED=true',
      'APPLE_LISTING_URLS=https://www.apple.com.cn/shop/refurbished/mac/mac-studio',
      'APPLE_MANUAL_URLS=https://www.apple.com.cn/shop/product/g1cepch/a',
      'APPLE_REQUEST_TIMEOUT_MS=7000',
      'SCHEDULER_ENABLED=true',
      'SCAN_INTERVAL_SECONDS=10',
      'SMS_DRY_RUN=false',
      'TENCENT_SECRET_ID=sid',
      'TENCENT_SECRET_KEY=skey',
      'TENCENT_SMS_SDK_APP_ID=1400000000',
      'TENCENT_SMS_SIGN_NAME=Apple Notify',
      'TENCENT_SMS_TEMPLATE_ID=123456',
      'TENCENT_SMS_PHONE_NUMBERS=+8613800000000',
      'TENCENT_SMS_TEMPLATE_PARAMS={productLabel},{price},{productId}',
      'TG_NOTIFY_ENABLED=true',
      'TG_BOT_TOKEN=dummy-token',
      'TG_CHAT_ID=987654321',
      'TG_API_BASE_URL=https://telegram.example.test',
      'TG_PROXY_ENABLED=true',
      'TG_HTTP_PROXY_URL=http://127.0.0.1:8800',
      '',
    ].join('\n'),
  );

  const config = loadConfig({}, { envFilePath });

  assert.equal(config.port, 8788);
  assert.equal(config.auth.adminToken, 'c'.repeat(32));
  assert.equal(config.apple.requestTimeoutMs, 7000);
  assert.equal(config.delivery.smsDryRun, false);
  assert.deepEqual(config.sms.phoneNumbers, ['+8613800000000']);
  assert.equal(config.telegram.botToken, 'dummy-token');
  assert.equal(config.telegram.proxyEnabled, true);
  assert.equal(config.telegram.httpProxyUrl, 'http://127.0.0.1:8800');
});

test('loadConfig lets .env file values override environment fallback values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-env-override-'));
  const envFilePath = path.join(dir, '.env');
  fs.writeFileSync(
    envFilePath,
    [
      `ADMIN_TOKEN=${'e'.repeat(32)}`,
      `LOCAL_SCRIPT_TOKEN=${'f'.repeat(32)}`,
      'TG_BOT_TOKEN=file-token',
      'TG_CHAT_ID=file-chat',
      '',
    ].join('\n'),
  );

  const config = loadConfig(
    {
      ADMIN_TOKEN: 'a'.repeat(32),
      LOCAL_SCRIPT_TOKEN: 'b'.repeat(32),
      TG_BOT_TOKEN: 'env-token',
      TG_CHAT_ID: 'env-chat',
    },
    { envFilePath },
  );

  assert.equal(config.auth.adminToken, 'e'.repeat(32));
  assert.equal(config.telegram.botToken, 'file-token');
  assert.equal(config.telegram.chatId, 'file-chat');
});

test('maskSecret redacts sensitive values', () => {
  assert.equal(maskSecret('1234567890abcdef'), '<redacted:16>');
  assert.equal(maskSecret(''), '<empty>');
});

