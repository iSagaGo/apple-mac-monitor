const assert = require('node:assert/strict');
const test = require('node:test');

const { loadConfig } = require('../src/config');
const {
  alertNtfyText,
  alertTelegramText,
  sendNtfyMessage,
  sendTelegramMessage,
  sendTencentSms,
  telegramSeparatorText,
} = require('../src/delivery');

test('loadConfig reads real SMS and Telegram delivery settings', () => {
  const config = loadConfig(
    {
      ADMIN_TOKEN: 'a'.repeat(32),
      LOCAL_SCRIPT_TOKEN: 'b'.repeat(32),
      SMS_DRY_RUN: 'false',
      TENCENT_SECRET_ID: 'sid',
      TENCENT_SECRET_KEY: 'skey',
      TENCENT_SMS_SDK_APP_ID: '1400000000',
      TENCENT_SMS_SIGN_NAME: 'Apple Notify',
      TENCENT_SMS_TEMPLATE_ID: '123456',
      TENCENT_SMS_PHONE_NUMBERS: '+8613800000000,+8613900000000',
      TENCENT_SMS_TEMPLATE_PARAMS: '{productLabel},{price},{productId}',
      DELIVERY_REQUEST_TIMEOUT_MS: '7000',
      TG_NOTIFY_ENABLED: 'true',
      TG_BOT_TOKEN: 'dummy-token',
      TG_CHAT_ID: '987654321',
      TG_API_BASE_URL: 'https://telegram.example.test',
      TG_PROXY_ENABLED: 'true',
      TG_HTTP_PROXY_URL: 'http://127.0.0.1:8800',
      TG_SEPARATOR_ENABLED: 'true',
      TG_SEPARATOR_INTERVAL_SECONDS: '21600',
    },
    { envFile: false },
  );

  assert.equal(config.delivery.smsDryRun, false);
  assert.equal(config.delivery.requestTimeoutMs, 7000);
  assert.deepEqual(config.sms.phoneNumbers, ['+8613800000000', '+8613900000000']);
  assert.deepEqual(config.sms.templateParams, ['{productLabel}', '{price}', '{productId}']);
  assert.equal(config.telegram.botToken, 'dummy-token');
  assert.equal(config.telegram.chatId, '987654321');
  assert.equal(config.telegram.apiBaseUrl, 'https://telegram.example.test');
  assert.equal(config.telegram.proxyEnabled, true);
  assert.equal(config.telegram.httpProxyUrl, 'http://127.0.0.1:8800');
  assert.equal(config.telegram.separatorEnabled, true);
  assert.equal(config.telegram.separatorIntervalSeconds, 21600);
});

test('sendTelegramMessage posts to the Telegram Bot API', async () => {
  let request = null;
  const result = await sendTelegramMessage({
    telegram: {
      botToken: 'dummy-token',
      chatId: '987654321',
      apiBaseUrl: 'https://telegram.example.test',
    },
    text: 'real TG test',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 12 } }),
      };
    },
  });

  assert.equal(request.url, 'https://telegram.example.test/botdummy-token/sendMessage');
  assert.deepEqual(request.body, {
    chat_id: '987654321',
    text: 'real TG test',
    disable_web_page_preview: false,
  });
  assert.equal(result.status, 'sent');
  assert.equal(result.providerMessageId, 12);
});

test('sendNtfyMessage posts a plain text message to the configured topic', async () => {
  let request = null;
  const result = await sendNtfyMessage({
    ntfy: {
      baseUrl: 'http://ntfy.example.test',
      topic: 'apple-openclaw-test',
      accessToken: 'tk_testtoken',
      priority: 'urgent',
    },
    title: 'Apple monitor',
    message: 'Mac Studio available',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({ id: 'msg-1', event: 'message' }),
      };
    },
  });

  assert.equal(request.url, 'http://ntfy.example.test/apple-openclaw-test');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer tk_testtoken');
  assert.equal(request.options.headers.Title, 'Apple monitor');
  assert.equal(request.options.headers.Priority, 'urgent');
  assert.equal(request.options.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(request.options.body, 'Mac Studio available');
  assert.equal(result.status, 'sent');
  assert.equal(result.providerMessageId, 'msg-1');
});

test('sendNtfyMessage treats successful plain text ntfy responses as sent', async () => {
  const result = await sendNtfyMessage({
    ntfy: {
      baseUrl: 'http://ntfy.example.test',
      topic: 'apple-openclaw-test',
    },
    title: 'Apple monitor',
    message: 'Mac Studio available',
    fetchImpl: async () =>
      new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
  });

  assert.equal(result.status, 'sent');
  assert.equal(result.providerMessageId, null);
  assert.deepEqual(result.response, { message: 'ok' });
});

test('alertNtfyText renders manual monitored products as readable plain text', () => {
  const text = alertNtfyText({
    detectedAt: '2026-05-18T23:20:00+08:00',
    manualOffers: [
      {
        title: 'Refurbished Mac Studio M3 Ultra',
        memoryText: '512GB',
        storageText: '1TB',
        price: { amount: 'RMB 63,099' },
        canonicalUrl: 'https://www.apple.com.cn/shop/product/g1ce3ch/a',
        availabilityStatus: 'available',
      },
      {
        title: 'Refurbished Mac Studio M3 Ultra',
        memoryText: '512GB',
        storageText: '2TB',
        price: { amount: 'RMB 65,599' },
        canonicalUrl: 'https://www.apple.com.cn/shop/product/g1ce8ch/a',
        availabilityStatus: 'unavailable',
      },
    ],
  });

  assert.match(text, /^Apple monitor alert/);
  assert.match(text, /2026-05-18 23:20:00 UTC\+8/);
  assert.match(text, /Available:/);
  assert.match(text, /512GB \/ 1TB/);
  assert.match(text, /https:\/\/www\.apple\.com\.cn\/shop\/product\/g1ce3ch\/a/);
  assert.match(text, /Unavailable:/);
  assert.match(text, /512GB \/ 2TB/);
});

test('sendTelegramMessage aborts slow Telegram requests', async () => {
  await assert.rejects(
    sendTelegramMessage({
      telegram: {
        botToken: 'dummy-token',
        chatId: '987654321',
        apiBaseUrl: 'https://telegram.example.test',
      },
      text: 'slow TG test',
      timeoutMs: 1,
      fetchImpl: async (url, options) =>
        new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    }),
    /delivery_request_timeout/,
  );
});

test('sendTelegramMessage can request Telegram HTML parsing', async () => {
  let body = null;
  await sendTelegramMessage({
    telegram: {
      botToken: 'dummy-token',
      chatId: '987654321',
      apiBaseUrl: 'https://telegram.example.test',
    },
    text: '<b>bold TG test</b>',
    parseMode: 'HTML',
    fetchImpl: async (url, options) => {
      body = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 13 } }),
      };
    },
  });

  assert.equal(body.parse_mode, 'HTML');
});

test('sendTelegramMessage attaches a proxy dispatcher only when enabled', async () => {
  const requests = [];
  const createProxyAgent = (proxyUrl) => ({ proxyUrl, marker: 'proxy-agent' });
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      json: async () => ({ ok: true, result: { message_id: requests.length } }),
    };
  };

  await sendTelegramMessage({
    telegram: {
      botToken: 'dummy-token',
      chatId: '987654321',
      apiBaseUrl: 'https://telegram.example.test',
      proxyEnabled: false,
      httpProxyUrl: 'http://127.0.0.1:8800',
    },
    text: 'no proxy',
    fetchImpl,
    createProxyAgent,
  });
  await sendTelegramMessage({
    telegram: {
      botToken: 'dummy-token',
      chatId: '987654321',
      apiBaseUrl: 'https://telegram.example.test',
      proxyEnabled: true,
      httpProxyUrl: 'http://127.0.0.1:8800',
    },
    text: 'with proxy',
    fetchImpl,
    createProxyAgent,
  });

  assert.equal(requests[0].options.dispatcher, undefined);
  assert.deepEqual(requests[1].options.dispatcher, {
    proxyUrl: 'http://127.0.0.1:8800',
    marker: 'proxy-agent',
  });
});

test('sendTencentSms aborts slow SMS requests', async () => {
  await assert.rejects(
    sendTencentSms({
      sms: {
        secretId: 'sid',
        secretKey: 'skey',
        sdkAppId: '1400000000',
        signName: 'Apple Notify',
        templateId: '123456',
        phoneNumbers: ['+8613800000000'],
        endpoint: 'https://sms.tencentcloudapi.com',
      },
      templateParams: ['Mac Studio'],
      timeoutMs: 1,
      fetchImpl: async (url, options) =>
        new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    }),
    /delivery_request_timeout/,
  );
});

test('alertTelegramText splits manual monitored products by purchase status', () => {
  const text = alertTelegramText({
    detectedAt: '2026-05-18T23:20:00+08:00',
    manualOffers: [
      {
        title: '缈绘柊 Mac Studio M3 Ultra',
        memoryText: '512GB',
        storageText: '1TB',
        price: { amount: 'RMB 63,099' },
        canonicalUrl: 'https://www.apple.com.cn/shop/product/g1ce3ch/a',
        availabilityStatus: 'available',
      },
      {
        title: '缈绘柊 Mac Studio M3 Ultra',
        memoryText: '512GB',
        storageText: '2TB',
        price: { amount: 'RMB 65,599' },
        canonicalUrl: 'https://www.apple.com.cn/shop/product/g1ce8ch/a',
        availabilityStatus: 'unavailable',
      },
    ],
  });

  assert.match(text, /^<b>.*2026-05-18 23:20:00 UTC\+8<\/b>\n\nApple /);
  assert.match(text, /512GB \/ 1TB/);
  assert.match(text, /https:\/\/www\.apple\.com\.cn\/shop\/product\/g1ce3ch\/a/);
  assert.match(text, /512GB \/ 2TB/);
  assert.doesNotMatch(text, /https:\/\/www\.apple\.com\.cn\/shop\/product\/g1ce8ch\/a/);
  assert.doesNotMatch(text, /\n.*2026-05-18 23:20:00 UTC\+8$/);
});

test('telegramSeparatorText renders bold arrow-only directional separators', () => {
  const up = telegramSeparatorText({ detectedAt: '2026-05-18T23:20:00+08:00', direction: 'up' });
  const down = telegramSeparatorText({ detectedAt: '2026-05-19T05:20:00+08:00', direction: 'down' });

  const upArrows = up.replace(/^<b>|<\/b>$/g, '');
  const downArrows = down.replace(/^<b>|<\/b>$/g, '');
  assert.match(up, /^<b>.*<\/b>$/);
  assert.match(down, /^<b>.*<\/b>$/);
  assert.equal([...upArrows].length, 30);
  assert.equal([...downArrows].length, 30);
  assert.notEqual(up, down);
});

test('sendTencentSms signs and sends a SendSms request', async () => {
  let request = null;
  const result = await sendTencentSms({
    sms: {
      secretId: 'sid',
      secretKey: 'skey',
      sdkAppId: '1400000000',
      signName: 'Apple Notify',
      templateId: '123456',
      phoneNumbers: ['+8613800000000'],
      endpoint: 'https://sms.tencentcloudapi.com',
    },
    templateParams: ['Mac Studio 512GB', 'RMB 92,399', 'G1CEPCH/A'],
    timestamp: 1770000000,
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({
          Response: {
            RequestId: 'req-1',
            SendStatusSet: [{ Code: 'Ok', Message: 'send success' }],
          },
        }),
      };
    },
  });

  assert.equal(request.url, 'https://sms.tencentcloudapi.com');
  assert.equal(request.options.headers['X-TC-Action'], 'SendSms');
  assert.equal(request.options.headers['X-TC-Version'], '2019-07-11');
  assert.match(request.options.headers.Authorization, /^TC3-HMAC-SHA256 Credential=sid\//);
  assert.deepEqual(request.body, {
    PhoneNumberSet: ['+8613800000000'],
    SmsSdkAppid: '1400000000',
    Sign: 'Apple Notify',
    TemplateID: '123456',
    TemplateParamSet: ['Mac Studio 512GB', 'RMB 92,399', 'G1CEPCH/A'],
    SessionContext: '',
  });
  assert.equal(result.status, 'sent');
  assert.equal(result.requestId, 'req-1');
});

