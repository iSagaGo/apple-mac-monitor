const crypto = require('node:crypto');

const { formatUtc8DisplayTime } = require('./time');

const TENCENT_SMS_ENDPOINT = 'https://sms.tencentcloudapi.com';
const TENCENT_SMS_SERVICE = 'sms';
const TENCENT_SMS_VERSION = '2019-07-11';
const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
const NTFY_DEFAULT_TITLE = 'Apple monitor';
const DEFAULT_DELIVERY_TIMEOUT_MS = 10000;

function defaultProxyAgent(proxyUrl) {
  // Loaded lazily so overseas deployments without proxy keep the normal direct path.
  const { ProxyAgent } = require('undici');
  return new ProxyAgent(proxyUrl);
}

function assertConfigured(value, name) {
  if (!value) {
    throw new Error(`${name}_not_configured`);
  }
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function utcDateFromTimestamp(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function tencentCloudHeaders({ action, body, endpoint, secretId, secretKey, timestamp, region = '' }) {
  const host = new URL(endpoint).host;
  const date = utcDateFromTimestamp(timestamp);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256Hex(body),
  ].join('\n');
  const credentialScope = `${date}/${TENCENT_SMS_SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, TENCENT_SMS_SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign, 'hex');
  const headers = {
    Authorization:
      `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'Content-Type': 'application/json; charset=utf-8',
    Host: host,
    'X-TC-Action': action,
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Version': TENCENT_SMS_VERSION,
  };
  if (region) {
    headers['X-TC-Region'] = region;
  }
  return headers;
}

async function parseJsonResponse(response) {
  const body = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(body));
  }
  return body;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS) {
  const parsedTimeoutMs = Math.max(1, Number(timeoutMs || DEFAULT_DELIVERY_TIMEOUT_MS));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), parsedTimeoutMs);

  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new Error('delivery_request_timeout');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function telegramFetchOptions({ telegram, text, createProxyAgent = defaultProxyAgent, parseMode = null }) {
  assertConfigured(telegram?.botToken, 'telegram_bot_token');
  assertConfigured(telegram?.chatId, 'telegram_chat_id');

  const body = {
    chat_id: telegram.chatId,
    text,
    disable_web_page_preview: false,
  };
  if (parseMode) {
    body.parse_mode = parseMode;
  }

  const options = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
  if (telegram.proxyEnabled) {
    assertConfigured(telegram.httpProxyUrl, 'telegram_http_proxy_url');
    options.dispatcher = createProxyAgent(telegram.httpProxyUrl);
  }
  return options;
}

async function sendTelegramMessage({
  telegram,
  text,
  fetchImpl = fetch,
  createProxyAgent = defaultProxyAgent,
  parseMode = null,
  timeoutMs = null,
}) {
  const apiBaseUrl = (telegram.apiBaseUrl || TELEGRAM_API_BASE_URL).replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    fetchImpl,
    `${apiBaseUrl}/bot${telegram.botToken}/sendMessage`,
    telegramFetchOptions({ telegram, text, createProxyAgent, parseMode }),
    timeoutMs ?? telegram.requestTimeoutMs,
  );
  const body = await parseJsonResponse(response);
  if (body.ok !== true) {
    throw new Error(body.description || 'telegram_send_failed');
  }
  return {
    status: 'sent',
    providerMessageId: body.result?.message_id ?? null,
    response: body,
  };
}

async function parseOptionalJsonResponse(response) {
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (!text) {
      return {};
    }
    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  }

  try {
    return await response.json();
  } catch {
    return {};
  }
}

function ntfyFetchOptions({ ntfy, title, message }) {
  assertConfigured(ntfy?.baseUrl, 'ntfy_base_url');
  assertConfigured(ntfy?.topic, 'ntfy_topic');

  const headers = {
    'content-type': 'text/plain; charset=utf-8',
    Title: title || NTFY_DEFAULT_TITLE,
  };
  if (ntfy.priority) {
    headers.Priority = ntfy.priority;
  }
  if (Array.isArray(ntfy.tags) && ntfy.tags.length > 0) {
    headers.Tags = ntfy.tags.join(',');
  }
  if (ntfy.accessToken) {
    headers.Authorization = `Bearer ${ntfy.accessToken}`;
  } else if (ntfy.username && ntfy.password) {
    headers.Authorization = `Basic ${Buffer.from(`${ntfy.username}:${ntfy.password}`).toString('base64')}`;
  }

  return {
    method: 'POST',
    headers,
    body: message,
  };
}

async function sendNtfyMessage({
  ntfy,
  title = NTFY_DEFAULT_TITLE,
  message,
  fetchImpl = fetch,
  timeoutMs = null,
}) {
  const baseUrl = (ntfy?.baseUrl || '').replace(/\/+$/, '');
  const topic = encodeURIComponent(ntfy?.topic || '');
  const response = await fetchWithTimeout(
    fetchImpl,
    `${baseUrl}/${topic}`,
    ntfyFetchOptions({ ntfy, title, message }),
    timeoutMs ?? ntfy?.requestTimeoutMs,
  );
  const body = await parseOptionalJsonResponse(response);
  if (!response.ok) {
    throw new Error(body.error || body.message || JSON.stringify(body));
  }
  return {
    status: 'sent',
    providerMessageId: body.id ?? null,
    response: body,
  };
}

async function sendTencentSms({
  sms,
  templateParams = [],
  timestamp = Math.floor(Date.now() / 1000),
  fetchImpl = fetch,
  timeoutMs = null,
}) {
  assertConfigured(sms?.secretId, 'tencent_secret_id');
  assertConfigured(sms?.secretKey, 'tencent_secret_key');
  assertConfigured(sms?.sdkAppId, 'tencent_sms_sdk_app_id');
  assertConfigured(sms?.signName, 'tencent_sms_sign_name');
  assertConfigured(sms?.templateId, 'tencent_sms_template_id');
  if (!Array.isArray(sms.phoneNumbers) || sms.phoneNumbers.length === 0) {
    throw new Error('tencent_sms_phone_numbers_not_configured');
  }

  const endpoint = sms.endpoint || TENCENT_SMS_ENDPOINT;
  const body = JSON.stringify({
    PhoneNumberSet: sms.phoneNumbers,
    SmsSdkAppid: sms.sdkAppId,
    Sign: sms.signName,
    TemplateID: sms.templateId,
    TemplateParamSet: templateParams.map(String),
    SessionContext: sms.sessionContext || '',
  });
  const response = await fetchWithTimeout(
    fetchImpl,
    endpoint,
    {
      method: 'POST',
      headers: tencentCloudHeaders({
        action: 'SendSms',
        body,
        endpoint,
        secretId: sms.secretId,
        secretKey: sms.secretKey,
        timestamp,
        region: sms.region,
      }),
      body,
    },
    timeoutMs ?? sms.requestTimeoutMs,
  );
  const result = await parseJsonResponse(response);
  if (result.Response?.Error) {
    throw new Error(`${result.Response.Error.Code}: ${result.Response.Error.Message}`);
  }
  const failed = (result.Response?.SendStatusSet || []).find((item) => item.Code && item.Code !== 'Ok');
  if (failed) {
    throw new Error(`${failed.Code}: ${failed.Message || 'sms_send_failed'}`);
  }
  return {
    status: 'sent',
    requestId: result.Response?.RequestId ?? null,
    response: result,
  };
}

function renderSmsTemplateParams(templateParams = [], payload = {}) {
  return templateParams.map((param) => {
    const text = String(param);
    const token = text.match(/^\{([a-zA-Z0-9_]+)\}$/)?.[1];
    return token ? String(payload[token] ?? '') : text;
  });
}

function escapeTelegramHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function offerDisplayName(offer = {}) {
  const parts = [
    offer.title || offer.productLabel || offer.model || offer.productId || '未知商品',
    offer.memoryText || offer.memory,
    offer.storageText || offer.storage,
    offer.price?.amount || offer.price,
  ].filter(Boolean);
  return parts.join(' / ');
}

function renderOfferList(offers, { includeLinks = true } = {}) {
  if (offers.length === 0) {
    return ['无'];
  }
  return offers.flatMap((offer, index) => {
    const url = offer.canonicalUrl || offer.url || '';
    return [
      `${index + 1}. ${escapeTelegramHtml(offerDisplayName(offer))}`,
      includeLinks ? escapeTelegramHtml(url) : null,
    ].filter(Boolean);
  });
}

function plainOfferDisplayName(offer = {}) {
  const price = typeof offer.price === 'object' ? offer.price?.amount : offer.price;
  const parts = [
    offer.title || offer.productLabel || offer.model || offer.productId || 'Unknown product',
    offer.memoryText || offer.memory,
    offer.storageText || offer.storage,
    price,
  ].filter(Boolean);
  return parts.join(' / ');
}

function renderPlainOfferList(offers, { includeLinks = true } = {}) {
  if (offers.length === 0) {
    return ['None'];
  }
  return offers.flatMap((offer, index) => {
    const url = offer.canonicalUrl || offer.url || '';
    return [
      `${index + 1}. ${plainOfferDisplayName(offer)}`,
      includeLinks && url ? url : null,
    ].filter(Boolean);
  });
}

function manualMonitorNtfyText(payload) {
  const manualOffers = Array.isArray(payload.manualOffers) ? payload.manualOffers : [];
  const availableOffers = manualOffers.filter((offer) => offer.availabilityStatus === 'available');
  const unavailableOffers = manualOffers.filter((offer) => offer.availabilityStatus !== 'available');

  return [
    'Apple monitor alert',
    payload.detectedAt ? `Time: ${formatUtc8DisplayTime(payload.detectedAt)}` : null,
    '',
    'Available:',
    ...renderPlainOfferList(availableOffers),
    '',
    'Unavailable:',
    ...renderPlainOfferList(unavailableOffers, { includeLinks: false }),
  ]
    .filter((line) => line !== null)
    .join('\n');
}

function manualMonitorTelegramText(payload) {
  const manualOffers = Array.isArray(payload.manualOffers) ? payload.manualOffers : [];
  const availableOffers = manualOffers.filter((offer) => offer.availabilityStatus === 'available');
  const unavailableOffers = manualOffers.filter((offer) => offer.availabilityStatus !== 'available');

  return [
    payload.detectedAt ? `<b>提示时间：${escapeTelegramHtml(formatUtc8DisplayTime(payload.detectedAt))}</b>` : null,
    '',
    'Apple 翻新 Mac 独立监控提醒',
    '',
    '可购买：',
    ...renderOfferList(availableOffers),
    '',
    '不可购买：',
    ...renderOfferList(unavailableOffers, { includeLinks: false }),
  ]
    .filter((line) => line !== null)
    .join('\n');
}

function telegramSeparatorText({ detectedAt, direction = 'up' } = {}) {
  const isDown = direction === 'down';
  const arrow = isDown ? '↓' : '↑';
  return `<b>${arrow.repeat(30)}</b>`;
}

function alertNtfyText(payload) {
  if (Array.isArray(payload.manualOffers)) {
    return manualMonitorNtfyText(payload);
  }

  return [
    'Apple monitor alert',
    payload.detectedAt ? `Time: ${formatUtc8DisplayTime(payload.detectedAt)}` : null,
    '',
    payload.productLabel || payload.title || payload.productId || null,
    payload.price ? `Price: ${payload.price}` : null,
    payload.productId ? `Product: ${payload.productId}` : null,
    payload.canonicalUrl || payload.url || null,
  ]
    .filter(Boolean)
    .join('\n');
}

function alertTelegramText(payload) {
  if (Array.isArray(payload.manualOffers)) {
    return manualMonitorTelegramText(payload);
  }

  return [
    payload.detectedAt ? `<b>提示时间：${escapeTelegramHtml(formatUtc8DisplayTime(payload.detectedAt))}</b>` : null,
    '',
    'Apple 翻新 Mac 有货提醒',
    payload.productLabel ? escapeTelegramHtml(payload.productLabel) : null,
    payload.price ? `价格：${escapeTelegramHtml(payload.price)}` : null,
    payload.productId ? `商品：${escapeTelegramHtml(payload.productId)}` : null,
    payload.canonicalUrl ? escapeTelegramHtml(payload.canonicalUrl) : null,
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = {
  alertNtfyText,
  alertTelegramText,
  renderSmsTemplateParams,
  sendNtfyMessage,
  sendTelegramMessage,
  sendTencentSms,
  telegramFetchOptions,
  telegramSeparatorText,
};
