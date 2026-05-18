const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { sendTelegramMessage, sendTencentSms } = require('./delivery');
const { canonicalizeAppleProductUrl } = require('./apple');
const { matchesAlertRule } = require('./rules');
const { scanOnce } = require('./scanner');
const { nowUtc8Iso } = require('./time');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_COOKIE = 'apple_monitor_session';
const SCAN_RATE_LIMIT_MS = 30_000;
const TEST_NOTIFY_RATE_LIMIT_MS = 30_000;
const MAX_JSON_BODY_BYTES = 64 * 1024;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeTimingEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(cookieHeader = '') {
  return Object.fromEntries(
    cookieHeader
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [key, ...valueParts] = part.split('=');
        return [key, decodeURIComponent(valueParts.join('='))];
      }),
  );
}

function sessionValue(config) {
  return sha256(`session:${config.auth.adminToken}`);
}

function isBearerAuthorized(req, config) {
  const authorization = req.headers.authorization || '';
  const expected = `Bearer ${config.auth.adminToken}`;
  return safeTimingEqual(authorization, expected);
}

function isSessionAuthorized(req, config) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE] && safeTimingEqual(cookies[SESSION_COOKIE], sessionValue(config));
}

function isAuthorized(req, config) {
  if (config.auth.localDevAuthDisabled) {
    return true;
  }
  return isBearerAuthorized(req, config) || isSessionAuthorized(req, config);
}

function isLocalAuthorized(req, config) {
  if (config.auth.localDevAuthDisabled) {
    return true;
  }
  const authorization = req.headers.authorization || '';
  return (
    safeTimingEqual(authorization, `Bearer ${config.auth.adminToken}`) ||
    safeTimingEqual(authorization, `Bearer ${config.auth.localScriptToken}`)
  );
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), {
    'content-type': 'application/json; charset=utf-8',
  });
}

function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: message });
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function readJsonBody(req) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of req) {
    byteLength += chunk.length;
    if (byteLength > MAX_JSON_BODY_BYTES) {
      throw httpError(413, 'request_body_too_large');
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  if (!body) {
    return {};
  }
  try {
    return JSON.parse(body);
  } catch {
    throw httpError(400, 'invalid_json');
  }
}

function optionalFiniteNumber(value, fieldName, ruleIndex) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw httpError(400, `rule ${ruleIndex + 1} ${fieldName} must be a finite number`);
  }
  return parsed;
}

function validateRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw httpError(400, 'rules must be a non-empty array');
  }
  return rules.map((rule, index) => {
    if (!rule || typeof rule !== 'object') {
      throw httpError(400, `rule ${index + 1} must be an object`);
    }
    if (!rule.id) {
      throw httpError(400, `rule ${index + 1} missing id`);
    }
    return {
      id: String(rule.id),
      enabled: rule.enabled !== false,
      model: rule.model ? String(rule.model) : undefined,
      chip: rule.chip ? String(rule.chip) : undefined,
      memory: Array.isArray(rule.memory) ? rule.memory.map(String) : [],
      storage: Array.isArray(rule.storage) ? rule.storage.map(String) : [],
      productIds: Array.isArray(rule.productIds) ? rule.productIds.map(String) : [],
      keywords: Array.isArray(rule.keywords) ? rule.keywords.map(String) : [],
      minPrice: optionalFiniteNumber(rule.minPrice, 'minPrice', index),
      maxPrice: optionalFiniteNumber(rule.maxPrice, 'maxPrice', index),
      repeatAlertAfterSeconds: optionalFiniteNumber(rule.repeatAlertAfterSeconds, 'repeatAlertAfterSeconds', index),
    };
  });
}

function effectiveRules(repo, config) {
  return repo.getSetting('alert_rules') || config.alerts.rules;
}

function effectiveSources(repo, config) {
  const savedSources = repo.getSetting('scan_sources') || {};
  return {
    listingEnabled: config.apple?.listingEnabled !== false,
    listingUrls: savedSources.listingUrls || config.apple.listingUrls,
    manualUrls: savedSources.manualUrls || config.apple.manualUrls,
  };
}

function effectiveConfig(repo, config) {
  const sources = effectiveSources(repo, config);
  return {
    ...config,
    apple: {
      ...(config.apple || {}),
      listingEnabled: sources.listingEnabled,
      listingUrls: sources.listingUrls,
      manualUrls: sources.manualUrls,
    },
    alerts: {
      ...(config.alerts || {}),
      rules: effectiveRules(repo, config),
    },
  };
}

function isManualOffer(offer) {
  return ['detail', 'detailVariation', 'manual'].includes(offer?.source);
}

function offerSortPriority(offer, rules) {
  let priority = 0;
  if (isManualOffer(offer)) {
    priority += 1;
  }
  if (rules.some((rule) => matchesAlertRule(offer, rule))) {
    priority += 1;
  }
  return priority;
}

function sortDashboardOffers(offers, rules) {
  return [...offers].sort((left, right) => {
    const priorityDelta = offerSortPriority(right, rules) - offerSortPriority(left, rules);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    const leftSeenAt = Date.parse(left.lastSeenAt);
    const rightSeenAt = Date.parse(right.lastSeenAt);
    const seenAtDelta = (Number.isFinite(rightSeenAt) ? rightSeenAt : 0) - (Number.isFinite(leftSeenAt) ? leftSeenAt : 0);
    if (seenAtDelta !== 0) {
      return seenAtDelta;
    }

    return String(left.productId || '').localeCompare(String(right.productId || ''));
  });
}

function canonicalDashboardUrl(value) {
  if (!value) return null;
  try {
    return canonicalizeAppleProductUrl(value, 'https://www.apple.com.cn');
  } catch {
    return String(value).trim();
  }
}

function coreDashboardOffers(offers, sources) {
  const manualUrls = new Set((sources.manualUrls || []).map(canonicalDashboardUrl).filter(Boolean));
  if (manualUrls.size === 0) {
    return [];
  }

  return offers.filter((offer) =>
    [offer.canonicalUrl, offer.url].map(canonicalDashboardUrl).some((item) => manualUrls.has(item)),
  );
}

function dashboardSummary(repo, config) {
  const rules = effectiveRules(repo, config);
  const sources = effectiveSources(repo, config);
  const offers = sortDashboardOffers(repo.listOfferSnapshots({ limit: 200 }), rules);
  return {
    ok: true,
    now: nowUtc8Iso(),
    rules,
    coreOffers: coreDashboardOffers(offers, sources),
    offers,
    windows: repo.listAvailabilityWindows({ limit: 100 }),
    scans: repo.listScanRuns({ limit: 20 }),
    eventCounts: repo.getEventCounts(),
    sources,
    delivery: config.delivery,
  };
}

function validateSourceUrls(body) {
  const listingUrls = Array.isArray(body.listingUrls) ? body.listingUrls : [];
  const manualUrls = Array.isArray(body.manualUrls) ? body.manualUrls : [];
  const normalized = {
    listingUrls: listingUrls.map((item) => String(item).trim()).filter(Boolean),
    manualUrls: manualUrls.map((item) => String(item).trim()).filter(Boolean),
  };

  if (normalized.listingUrls.length === 0 && normalized.manualUrls.length === 0) {
    throw httpError(400, 'at least one scan source URL is required');
  }

  for (const url of [...normalized.listingUrls, ...normalized.manualUrls]) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw httpError(400, `invalid Apple URL: ${url}`);
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.apple.com.cn') {
      throw httpError(400, `invalid Apple URL: ${url}`);
    }
  }

  return normalized;
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
    }[extension] || 'application/octet-stream'
  );
}

function safeStaticPath(urlPath) {
  const relativePath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  const root = path.resolve(PUBLIC_DIR);
  const relativeToRoot = path.relative(root, filePath);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    return null;
  }
  return filePath;
}

function localEventAckStatus(body) {
  const status = String(body.status || 'delivered');
  if (!['delivered', 'failed'].includes(status)) {
    throw httpError(400, 'invalid_local_event_status');
  }
  return status;
}

function serveStatic(req, res, url, config) {
  if (!isAuthorized(req, config)) {
    send(
      res,
      401,
      '<!doctype html><meta charset="utf-8"><title>Unauthorized</title><body>需要认证。请使用 /?token=ADMIN_TOKEN 登录。</body>',
      { 'content-type': 'text/html; charset=utf-8' },
    );
    return;
  }

  const filePath = safeStaticPath(url.pathname);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendError(res, 404, 'not_found');
    return;
  }

  send(res, 200, fs.readFileSync(filePath), {
    'content-type': contentTypeFor(filePath),
  });
}

function createRateLimiter(intervalMs) {
  let lastRunAt = 0;
  return function rateLimit() {
    if (intervalMs <= 0) {
      return { allowed: true, retryAfterMs: 0 };
    }
    const now = Date.now();
    const retryAfterMs = intervalMs - (now - lastRunAt);
    if (retryAfterMs > 0) {
      return { allowed: false, retryAfterMs };
    }
    lastRunAt = now;
    return { allowed: true, retryAfterMs: 0 };
  };
}

function smsTestParams(body, config) {
  return Array.isArray(body.templateParams) ? body.templateParams.map(String) : config.sms?.templateParams ?? [];
}

function telegramTestMessage(body) {
  return String(body.message || 'Apple Mac Monitor TG 真实发送测试');
}

function createHttpServer({
  config,
  repo,
  scanOnceImpl = scanOnce,
  fetchImpl = fetch,
  notifyTestRateLimitMs = TEST_NOTIFY_RATE_LIMIT_MS,
}) {
  const scanRateLimit = createRateLimiter(SCAN_RATE_LIMIT_MS);
  const notifyTestRateLimit = createRateLimiter(notifyTestRateLimitMs);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    try {
      if (url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true, now: nowUtc8Iso() });
        return;
      }

      if (url.pathname === '/' && url.searchParams.get('token')) {
        if (!safeTimingEqual(url.searchParams.get('token'), config.auth.adminToken)) {
          sendError(res, 401, 'invalid_token');
          return;
        }
        send(res, 302, '', {
          location: '/',
          'set-cookie': `${SESSION_COOKIE}=${encodeURIComponent(
            sessionValue(config),
          )}; HttpOnly; SameSite=Lax; Path=/`,
        });
        return;
      }

      if (url.pathname.startsWith('/api/local/')) {
        if (!isLocalAuthorized(req, config)) {
          sendError(res, 401, 'unauthorized');
          return;
        }
      } else if (url.pathname.startsWith('/api/') && !isAuthorized(req, config)) {
        sendError(res, 401, 'unauthorized');
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/summary') {
        sendJson(res, 200, dashboardSummary(repo, config));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/rules') {
        sendJson(res, 200, { ok: true, rules: effectiveRules(repo, config) });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/sources') {
        sendJson(res, 200, { ok: true, sources: effectiveSources(repo, config) });
        return;
      }

      if (req.method === 'PUT' && url.pathname === '/api/sources') {
        const body = await readJsonBody(req);
        const sources = validateSourceUrls(body);
        repo.setSetting('scan_sources', sources, nowUtc8Iso());
        sendJson(res, 200, { ok: true, sources: effectiveSources(repo, config) });
        return;
      }

      if (req.method === 'PUT' && url.pathname === '/api/rules') {
        const body = await readJsonBody(req);
        const rules = validateRules(body.rules);
        repo.setSetting('alert_rules', rules, nowUtc8Iso());
        sendJson(res, 200, { ok: true, rules });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/scan/run') {
        const limited = scanRateLimit();
        if (!limited.allowed) {
          sendJson(res, 429, {
            ok: false,
            error: 'rate_limited',
            retryAfterMs: limited.retryAfterMs,
          });
          return;
        }
        const summary = await scanOnceImpl({
          config: effectiveConfig(repo, config),
          repo,
          source: 'api_manual',
        });
        sendJson(res, 200, { ok: true, summary });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/sms/test') {
        const limited = notifyTestRateLimit();
        if (!limited.allowed) {
          sendJson(res, 429, { ok: false, error: 'rate_limited', retryAfterMs: limited.retryAfterMs });
          return;
        }
        const body = await readJsonBody(req);
        if (config.delivery?.smsDryRun !== false) {
          sendJson(res, 200, {
            ok: true,
            status: 'dry_run',
            channel: 'sms',
            now: nowUtc8Iso(),
          });
          return;
        }
        const result = await sendTencentSms({
          sms: config.sms,
          templateParams: smsTestParams(body, config),
          fetchImpl,
        });
        sendJson(res, 200, {
          ok: true,
          status: result.status,
          channel: 'sms',
          requestId: result.requestId,
          now: nowUtc8Iso(),
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/telegram/test') {
        const limited = notifyTestRateLimit();
        if (!limited.allowed) {
          sendJson(res, 429, { ok: false, error: 'rate_limited', retryAfterMs: limited.retryAfterMs });
          return;
        }
        const body = await readJsonBody(req);
        if (config.delivery?.telegramEnabled === false || !config.telegram?.botToken || !config.telegram?.chatId) {
          sendJson(res, 200, {
            ok: true,
            status: 'dry_run',
            channel: 'telegram',
            now: nowUtc8Iso(),
          });
          return;
        }
        const result = await sendTelegramMessage({
          telegram: config.telegram,
          text: telegramTestMessage(body),
          fetchImpl,
        });
        sendJson(res, 200, {
          ok: true,
          status: result.status,
          channel: 'telegram',
          providerMessageId: result.providerMessageId,
          now: nowUtc8Iso(),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/local/events') {
        sendJson(res, 200, { ok: true, events: repo.listLocalEvents?.({ limit: 100, status: 'pending' }) ?? [] });
        return;
      }

      const localEventAckMatch = url.pathname.match(/^\/api\/local\/events\/(\d+)\/ack$/);
      if (req.method === 'POST' && localEventAckMatch) {
        const body = await readJsonBody(req);
        const status = localEventAckStatus(body);
        const deliveredAt = nowUtc8Iso();
        const updated = repo.markLocalEvent?.(Number(localEventAckMatch[1]), {
          status,
          deliveredAt,
          error: status === 'failed' ? String(body.error || 'local_delivery_failed') : null,
        });
        if (!updated) {
          sendError(res, 404, 'local_event_not_found');
          return;
        }
        sendJson(res, 200, { ok: true, status, deliveredAt });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        sendError(res, 404, 'not_found');
        return;
      }

      serveStatic(req, res, url, config);
    } catch (error) {
      sendError(res, error.statusCode || 500, error.message);
    }
  });
}

module.exports = {
  createHttpServer,
  dashboardSummary,
  effectiveConfig,
  effectiveRules,
  effectiveSources,
  safeStaticPath,
  sortDashboardOffers,
};
