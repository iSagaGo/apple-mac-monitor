const crypto = require('node:crypto');

const { formatUtc8DisplayTime } = require('./time');

const TENCENT_SMS_ENDPOINT = 'https://sms.tencentcloudapi.com';
const TENCENT_SMS_SERVICE = 'sms';
const TENCENT_SMS_VERSION = '2019-07-11';
const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';

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
}) {
  const apiBaseUrl = (telegram.apiBaseUrl || TELEGRAM_API_BASE_URL).replace(/\/+$/, '');
  const response = await fetchImpl(
    `${apiBaseUrl}/bot${telegram.botToken}/sendMessage`,
    telegramFetchOptions({ telegram, text, createProxyAgent, parseMode }),
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

async function sendTencentSms({ sms, templateParams = [], timestamp = Math.floor(Date.now() / 1000), fetchImpl = fetch }) {
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
  const response = await fetchImpl(endpoint, {
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
  });
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
  alertTelegramText,
  renderSmsTemplateParams,
  sendTelegramMessage,
  sendTencentSms,
  telegramFetchOptions,
  telegramSeparatorText,
};
