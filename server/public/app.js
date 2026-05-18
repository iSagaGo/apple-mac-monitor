const state = {
  scanCooldownTimer: null,
  scanRunning: false,
  summary: null,
};

const AUTO_REFRESH_INTERVAL_MS = 10_000;
const SCAN_COOLDOWN_SECONDS = 10;
const REFRESH_BUTTON_TEXT = '刷新';
const SCAN_BUTTON_TEXT = '立即扫描';

const $ = (selector) => document.querySelector(selector);

function csv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinCsv(value) {
  return Array.isArray(value) ? value.join(',') : '';
}

function lines(value) {
  return String(value || '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinLines(value) {
  return Array.isArray(value) ? value.join('\n') : '';
}

function setText(selector, value) {
  $(selector).textContent = value;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function safeAppleHref(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'www.apple.com.cn') {
      return '#';
    }
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '#';
  }
}

function isDialogOpen(selector) {
  return Boolean($(selector)?.open);
}

function formatDisplayTime(value) {
  if (!value) return '';
  const text = String(value);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?\+08:00$/);
  if (!match) return text;
  return `${match[1]} ${match[2]} UTC+8`;
}

function scanStatusLabel(status) {
  return (
    {
      completed: '已完成',
      completed_with_errors: '已完成，有错误',
      failed: '失败',
      running: '扫描中',
    }[status] || status || '等待'
  );
}

function scanStatusText(scans = []) {
  const latest = scans[0];
  if (!latest) return '等待';
  return scanStatusLabel(latest.status);
}

function statusClass(status) {
  if (status === 'available' || status === 'open') return 'available';
  if (status === 'unavailable' || status === 'closed') return 'unavailable';
  return 'unknown';
}

function renderRules(rules) {
  const rule = rules[0] || {};
  $('#ruleId').value = rule.id || 'mac-studio-512gb';
  $('#ruleModel').value = rule.model || 'Mac Studio';
  $('#ruleMemory').value = joinCsv(rule.memory);
  $('#ruleStorage').value = joinCsv(rule.storage);
  $('#ruleMaxPrice').value = rule.maxPrice || '';
  $('#ruleRepeatAfter').value = rule.repeatAlertAfterSeconds || '';
}

function renderSources(sources) {
  $('#listingUrlsInput').value = joinLines(sources.listingUrls);
  $('#manualUrlsInput').value = joinLines(sources.manualUrls);
}

function optionalNumberInput(selector, label) {
  const raw = $(selector).value.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${label}必须是数字`);
  }
  return value;
}

function offerIdentity(offer) {
  return String(offer?.canonicalUrl || offer?.url || offer?.productId || '');
}

function offerRowHtml(offer) {
  const config = [offer.chip, offer.memoryText || offer.memory, offer.storageText || offer.storage]
    .filter(Boolean)
    .join(' / ');
  const href = safeAppleHref(offer.canonicalUrl || offer.url || '#');
  const productName = offer.title || offer.model || offer.productId || '查看商品';
  const productMeta = [offer.productId, offer.model && offer.model !== productName ? offer.model : null]
    .filter(Boolean)
    .join(' / ');
  return `
    <tr>
      <td><span class="pill ${escapeAttribute(statusClass(offer.availabilityStatus))}">${escapeHtml(offer.availabilityStatus)}</span></td>
      <td><a href="${escapeAttribute(href)}" target="_blank" rel="noreferrer">${escapeHtml(productName)}</a><br><span class="muted">${escapeHtml(productMeta)}</span></td>
      <td>${escapeHtml(config)}</td>
      <td>${escapeHtml(offer.price?.amount || offer.price?.rawAmount || '')}</td>
      <td>${formatDisplayTime(offer.lastSeenAt)}</td>
    </tr>
  `;
}

function renderOfferTable(selector, offers, emptyMessage) {
  $(selector).innerHTML =
    offers.map(offerRowHtml).join('') ||
    `<tr><td colspan="5" class="muted empty-row">${escapeHtml(emptyMessage)}</td></tr>`;
}

function renderCoreOffers(offers) {
  renderOfferTable('#coreOffersBody', offers, '还没有核心商品。');
}

function renderOffers(offers, coreOffers = []) {
  const coreKeys = new Set(coreOffers.map(offerIdentity).filter(Boolean));
  const recentOffers = offers.filter((offer) => !coreKeys.has(offerIdentity(offer)));
  renderOfferTable('#offersBody', recentOffers, '还没有最近商品。');
}

function setRecentProductsVisible(visible) {
  const panel = $('#recentProductsPanel');
  if (!panel) return;
  panel.hidden = !visible;
  panel.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function renderWindows(windows) {
  $('#windows').innerHTML =
    windows
      .map(
        (item) => `
          <div class="window">
            <span class="pill ${escapeAttribute(statusClass(item.status))}">${escapeHtml(item.status)}</span>
            <div>
              <a href="${escapeAttribute(safeAppleHref(item.canonicalUrl))}" target="_blank" rel="noreferrer">${escapeHtml(item.productId || item.fingerprint)}</a>
              <div class="muted">${escapeHtml(item.openReason || '')} / alerts ${escapeHtml(item.alertCount)}</div>
            </div>
            <div class="muted">${formatDisplayTime(item.openedAt)}</div>
          </div>
        `,
      )
      .join('') || '<p class="muted">还没有提醒窗口。</p>';
}

function renderSummary(summary) {
  state.summary = summary;
  const coreOffers = summary.coreOffers || [];
  const showRecentProducts = summary.sources?.listingEnabled !== false;
  setText('#offerCount', showRecentProducts ? summary.offers.length : coreOffers.length);
  setText('#windowCount', summary.windows.length);
  setText('#smsCount', summary.eventCounts.sms);
  setText('#telegramCount', summary.eventCounts.telegram);
  setText('#lastUpdated', `更新时间 ${formatDisplayTime(summary.now)}`);
  setText('#activeRuleCount', summary.rules.length);
  setText('#lastScanState', scanStatusText(summary.scans));
  if (!isDialogOpen('#ruleDialog')) {
    renderRules(summary.rules);
  }
  if (!isDialogOpen('#sourceDialog')) {
    renderSources(summary.sources);
  }
  renderCoreOffers(coreOffers);
  setRecentProductsVisible(showRecentProducts);
  if (showRecentProducts) {
    renderOffers(summary.offers, coreOffers);
  } else {
    $('#offersBody').innerHTML = '';
  }
  renderWindows(summary.windows);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    cache: 'no-store',
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

async function loadSummary() {
  const summary = await api('/api/summary');
  renderSummary(summary);
}

function refreshDashboard() {
  loadSummary().catch((error) => {
    $('#scanMessage').textContent = error.message;
  });
}

async function handleManualRefresh() {
  const button = $('#refreshButton');
  button.disabled = true;
  button.textContent = '刷新中';
  try {
    await loadSummary();
  } catch (error) {
    $('#scanMessage').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = REFRESH_BUTTON_TEXT;
  }
}

async function saveRules(event) {
  event.preventDefault();
  $('#saveStatus').textContent = '保存中';
  try {
    const rule = {
      id: $('#ruleId').value.trim(),
      model: $('#ruleModel').value.trim(),
      memory: csv($('#ruleMemory').value),
      storage: csv($('#ruleStorage').value),
      maxPrice: optionalNumberInput('#ruleMaxPrice', '最高价格'),
      repeatAlertAfterSeconds: optionalNumberInput('#ruleRepeatAfter', '二次提醒阈值秒'),
    };
    await api('/api/rules', {
      method: 'PUT',
      body: JSON.stringify({ rules: [rule] }),
    });
    $('#saveStatus').textContent = '已保存';
    closeRuleDialog();
    await loadSummary();
  } catch (error) {
    $('#saveStatus').textContent = error.message;
  }
}

function openRuleDialog() {
  $('#saveStatus').textContent = '未保存变更';
  const dialog = $('#ruleDialog');
  if (dialog.showModal) {
    dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
}

function closeRuleDialog() {
  const dialog = $('#ruleDialog');
  if (dialog.close) {
    dialog.close();
  } else {
    dialog.removeAttribute('open');
  }
}

async function saveSources(event) {
  event.preventDefault();
  $('#sourceStatus').textContent = '保存中';
  try {
    const result = await api('/api/sources', {
      method: 'PUT',
      body: JSON.stringify({
        listingUrls: lines($('#listingUrlsInput').value),
        manualUrls: lines($('#manualUrlsInput').value),
      }),
    });
    $('#sourceStatus').textContent = '已保存';
    renderSources(result.sources);
    closeSourceDialog();
    await loadSummary();
  } catch (error) {
    $('#sourceStatus').textContent = error.message;
  }
}

function openSourceDialog() {
  $('#sourceStatus').textContent = '每行一个 Apple 链接';
  const dialog = $('#sourceDialog');
  if (dialog.showModal) {
    dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
}

function closeSourceDialog() {
  const dialog = $('#sourceDialog');
  if (dialog.close) {
    dialog.close();
  } else {
    dialog.removeAttribute('open');
  }
}

function setScanCooldownText(seconds) {
  const button = $('#scanButton');
  button.disabled = true;
  button.textContent = `冷却 ${seconds}s`;
}

function finishScanCooldown() {
  state.scanCooldownTimer = null;
  state.scanRunning = false;
  const button = $('#scanButton');
  button.disabled = false;
  button.textContent = SCAN_BUTTON_TEXT;
}

function startScanCooldown(seconds = SCAN_COOLDOWN_SECONDS) {
  if (state.scanCooldownTimer) {
    clearTimeout(state.scanCooldownTimer);
  }
  let remaining = seconds;
  setScanCooldownText(remaining);

  const tick = () => {
    remaining -= 1;
    if (remaining <= 0) {
      finishScanCooldown();
      return;
    }
    setScanCooldownText(remaining);
    state.scanCooldownTimer = setTimeout(tick, 1000);
  };

  state.scanCooldownTimer = setTimeout(tick, 1000);
}

async function runScan() {
  if (state.scanRunning || state.scanCooldownTimer) return;
  state.scanRunning = true;
  $('#scanButton').disabled = true;
  $('#scanButton').textContent = '扫描中';
  $('#scanMessage').textContent = '正在扫描 Apple 页面';
  try {
    const result = await api('/api/scan/run', { method: 'POST', body: '{}' });
    $('#scanMessage').textContent = `完成：扫描 ${result.summary.scannedOffers} 个，匹配 ${result.summary.matchedOffers} 个，提醒 ${result.summary.alertsCreated} 个`;
    await loadSummary();
  } catch (error) {
    $('#scanMessage').textContent = error.message === 'rate_limited' ? '扫描太频繁，请稍后再试' : error.message;
  } finally {
    startScanCooldown();
  }
}

$('#ruleForm').addEventListener('submit', saveRules);
$('#sourceForm').addEventListener('submit', saveSources);
$('#refreshButton').addEventListener('click', handleManualRefresh);
$('#ruleButton').addEventListener('click', openRuleDialog);
$('#ruleCloseButton').addEventListener('click', closeRuleDialog);
$('#sourceButton').addEventListener('click', openSourceDialog);
$('#sourceCloseButton').addEventListener('click', closeSourceDialog);
$('#scanButton').addEventListener('click', runScan);

refreshDashboard();

const autoRefreshTimer = setInterval(refreshDashboard, AUTO_REFRESH_INTERVAL_MS);
window.addEventListener(
  'pagehide',
  () => {
    clearInterval(autoRefreshTimer);
    if (state.scanCooldownTimer) {
      clearTimeout(state.scanCooldownTimer);
    }
  },
  { once: true },
);
