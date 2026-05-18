const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_LISTING_URL = 'https://www.apple.com.cn/shop/refurbished/mac/mac-studio';
const DEFAULT_MANUAL_URL = 'https://www.apple.com.cn/shop/product/g1cepch/a';
const DEFAULT_ENV_FILE = path.join(__dirname, '..', '.env');

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseIntWithDefault(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsv(value, fallback) {
  const parsed = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requireStrongToken(name, value, localDevAuthDisabled) {
  if (localDevAuthDisabled) return value || '';
  if (!value || String(value).length < 32) {
    throw new Error(`${name} must be at least 32 characters unless LOCAL_DEV_AUTH_DISABLED=true`);
  }
  return String(value);
}

function parseEnvFileText(text) {
  const parsed = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function readEnvFile(envFilePath = DEFAULT_ENV_FILE) {
  if (!envFilePath || !fs.existsSync(envFilePath)) {
    return {};
  }
  return parseEnvFileText(fs.readFileSync(envFilePath, 'utf8'));
}

function loadEnv(env = process.env, options = {}) {
  if (options.envFile === false) {
    return { ...env };
  }
  const envFilePath = options.envFilePath || env.ENV_FILE || DEFAULT_ENV_FILE;
  const fileEnv = options.envFile || readEnvFile(envFilePath);
  return { ...env, ...fileEnv };
}

function maskSecret(value) {
  if (!value) return '<empty>';
  return `<redacted:${String(value).length}>`;
}

function loadConfig(env = process.env, options = {}) {
  const mergedEnv = loadEnv(env, options);
  const localDevAuthDisabled = parseBool(mergedEnv.LOCAL_DEV_AUTH_DISABLED, false);
  const dataDir = mergedEnv.DATA_DIR || path.join(__dirname, '..', 'data');
  const telegramApiBaseUrl =
    mergedEnv.TG_API_BASE_URL || mergedEnv.TG_NOTIFY_PROXY_URL || 'https://api.telegram.org';

  return {
    port: parseIntWithDefault(mergedEnv.PORT, 8787),
    dataDir,
    databasePath: path.join(dataDir, 'apple-monitor.sqlite'),
    auth: {
      adminToken: requireStrongToken('ADMIN_TOKEN', mergedEnv.ADMIN_TOKEN || '', localDevAuthDisabled),
      localScriptToken: requireStrongToken(
        'LOCAL_SCRIPT_TOKEN',
        mergedEnv.LOCAL_SCRIPT_TOKEN || '',
        localDevAuthDisabled,
      ),
      localDevAuthDisabled,
    },
    apple: {
      listingEnabled: parseBool(mergedEnv.APPLE_LISTING_ENABLED, false),
      listingUrls: parseCsv(mergedEnv.APPLE_LISTING_URLS, [DEFAULT_LISTING_URL]),
      manualUrls: parseCsv(mergedEnv.APPLE_MANUAL_URLS, [DEFAULT_MANUAL_URL]),
      listIntervalSeconds: parseIntWithDefault(mergedEnv.APPLE_LIST_INTERVAL_SECONDS, 45),
      detailIntervalSeconds: parseIntWithDefault(mergedEnv.APPLE_DETAIL_INTERVAL_SECONDS, 15),
      scanConcurrency: parseIntWithDefault(mergedEnv.APPLE_SCAN_CONCURRENCY, 2),
      requestTimeoutMs: parseIntWithDefault(mergedEnv.APPLE_REQUEST_TIMEOUT_MS, 15000),
    },
    scheduler: {
      enabled: parseBool(mergedEnv.SCHEDULER_ENABLED, true),
      scanIntervalSeconds: parseIntWithDefault(mergedEnv.SCAN_INTERVAL_SECONDS, 10),
    },
    alerts: {
      rules: [
        {
          id: mergedEnv.ALERT_RULE_ID || 'mac-studio-512gb',
          enabled: !parseBool(mergedEnv.ALERT_DISABLED, false),
          model: mergedEnv.ALERT_MODEL || 'Mac Studio',
          memory: parseCsv(mergedEnv.ALERT_MEMORY, ['512gb']),
          storage: parseCsv(mergedEnv.ALERT_STORAGE, []),
          chip: mergedEnv.ALERT_CHIP || undefined,
          minPrice: parseOptionalNumber(mergedEnv.ALERT_MIN_PRICE),
          maxPrice: parseOptionalNumber(mergedEnv.ALERT_MAX_PRICE),
          repeatAlertAfterSeconds: parseOptionalNumber(mergedEnv.ALERT_REPEAT_AFTER_SECONDS),
        },
      ],
    },
    delivery: {
      smsDryRun: parseBool(mergedEnv.SMS_DRY_RUN, true),
      telegramEnabled: parseBool(mergedEnv.TG_NOTIFY_ENABLED, true),
      localEventsEnabled: parseBool(mergedEnv.LOCAL_EVENTS_ENABLED, true),
    },
    sms: {
      secretId: mergedEnv.TENCENT_SECRET_ID || '',
      secretKey: mergedEnv.TENCENT_SECRET_KEY || '',
      sdkAppId: mergedEnv.TENCENT_SMS_SDK_APP_ID || '',
      signName: mergedEnv.TENCENT_SMS_SIGN_NAME || '',
      templateId: mergedEnv.TENCENT_SMS_TEMPLATE_ID || '',
      phoneNumbers: parseCsv(mergedEnv.TENCENT_SMS_PHONE_NUMBERS, []),
      templateParams: parseCsv(mergedEnv.TENCENT_SMS_TEMPLATE_PARAMS, []),
      endpoint: mergedEnv.TENCENT_SMS_ENDPOINT || 'https://sms.tencentcloudapi.com',
      region: mergedEnv.TENCENT_SMS_REGION || '',
    },
    telegram: {
      botToken: mergedEnv.TG_BOT_TOKEN || '',
      chatId: mergedEnv.TG_CHAT_ID || '',
      apiBaseUrl: telegramApiBaseUrl,
      proxyEnabled: parseBool(mergedEnv.TG_PROXY_ENABLED, false),
      httpProxyUrl: mergedEnv.TG_HTTP_PROXY_URL || '',
      separatorEnabled: parseBool(mergedEnv.TG_SEPARATOR_ENABLED, true),
      separatorIntervalSeconds: parseIntWithDefault(mergedEnv.TG_SEPARATOR_INTERVAL_SECONDS, 21600),
    },
  };
}

module.exports = {
  DEFAULT_ENV_FILE,
  DEFAULT_LISTING_URL,
  DEFAULT_MANUAL_URL,
  loadConfig,
  maskSecret,
  parseEnvFileText,
  readEnvFile,
};
