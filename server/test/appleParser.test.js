const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  canonicalizeAppleProductUrl,
  parseProductDetail,
  parseRefurbListings,
} = require('../src/apple');

const fixturesDir = path.join(__dirname, 'fixtures', 'apple');

test('parseRefurbListings reads Apple refurb grid bootstrap data', () => {
  const html = fs.readFileSync(path.join(fixturesDir, 'mac-studio-listing.html'), 'utf8');
  const listings = parseRefurbListings(html, {
    baseUrl: 'https://www.apple.com.cn',
  });

  assert.equal(listings.length, 95);
  assert.equal(listings[0].productId, 'FU9D3CH/A');
  assert.equal(listings[0].basePartNumber, 'FU9D3');
  assert.equal(listings[0].model, 'Mac mini');
  assert.equal(listings[0].storage, '256gb');
  assert.equal(listings[0].memory, '16gb');
  assert.equal(listings[0].price.amount, 'RMB 3,799');
  assert.equal(listings[0].availabilityStatus, 'available');
  assert.match(listings[0].url, /^https:\/\/www\.apple\.com\.cn\/shop\/product\/fu9d3ch\/a\?/);
});

test('parseRefurbListings can filter Mac Studio offers from a listing page', () => {
  const bootstrap = {
    dictionaries: {
      dimensions: {
        dimensionCapacity: { '16tb': { text: '16TB' } },
        refurbClearModel: { macstudio: { text: 'Mac Studio' } },
        tsMemorySize: { '512gb': { text: '512GB' } },
      },
    },
    tiles: [
      {
        productDetailsUrl: '/shop/product/g1cepch/a?fnode=abc',
        partNumber: 'G1CEPCH/A',
        title: 'Refurbished Mac Studio Apple M3 Ultra chip with 32-Core CPU and 80-Core GPU',
        price: {
          basePartNumber: 'G1CEP',
          currentPrice: { amount: 'RMB 92,399', raw_amount: '92399.00' },
        },
        filters: {
          dimensions: {
            dimensionCapacity: '16tb',
            refurbClearModel: 'macstudio',
            tsMemorySize: '512gb',
          },
        },
      },
      {
        productDetailsUrl: '/shop/product/fu9d3ch/a',
        partNumber: 'FU9D3CH/A',
        title: 'Refurbished Mac mini',
        filters: { dimensions: { refurbClearModel: 'macmini' } },
      },
    ],
  };
  const html = `<script>window.REFURB_GRID_BOOTSTRAP = ${JSON.stringify(bootstrap)};</script>`;

  const macStudioListings = parseRefurbListings(html, {
    baseUrl: 'https://www.apple.com.cn',
    model: 'Mac Studio',
  });

  assert.equal(macStudioListings.length, 1);
  assert.deepEqual(
    {
      productId: macStudioListings[0].productId,
      model: macStudioListings[0].model,
      chip: macStudioListings[0].chip,
      cpuCores: macStudioListings[0].cpuCores,
      gpuCores: macStudioListings[0].gpuCores,
      memory: macStudioListings[0].memory,
      memoryText: macStudioListings[0].memoryText,
      storage: macStudioListings[0].storage,
      storageText: macStudioListings[0].storageText,
      availabilityStatus: macStudioListings[0].availabilityStatus,
      canonicalUrl: macStudioListings[0].canonicalUrl,
    },
    {
      productId: 'G1CEPCH/A',
      model: 'Mac Studio',
      chip: 'M3 Ultra',
      cpuCores: 32,
      gpuCores: 80,
      memory: '512gb',
      memoryText: '512GB',
      storage: '16tb',
      storageText: '16TB',
      availabilityStatus: 'available',
      canonicalUrl: 'https://www.apple.com.cn/shop/product/g1cepch/a',
    },
  );
});

test('parseProductDetail extracts selected Mac Studio configuration and unavailable state', () => {
  const html = fs.readFileSync(path.join(fixturesDir, 'g1cepch-detail.html'), 'utf8');
  const detail = parseProductDetail(html, {
    url: 'https://www.apple.com.cn/shop/product/g1cepch/a',
  });

  assert.equal(detail.productId, 'G1CEPCH/A');
  assert.equal(detail.basePartNumber, 'G1CEP');
  assert.equal(detail.model, 'Mac Studio');
  assert.equal(detail.chip, 'M3 Ultra');
  assert.equal(detail.cpuCores, 32);
  assert.equal(detail.gpuCores, 80);
  assert.equal(detail.memory, '512gb');
  assert.equal(detail.memoryText, '512GB');
  assert.equal(detail.storage, '16tb');
  assert.equal(detail.storageText, '16TB');
  assert.equal(detail.price.amount, 'RMB 92,399');
  assert.equal(detail.price.rawAmount, 92399);
  assert.equal(detail.availabilityStatus, 'unavailable');
  assert.deepEqual(detail.availabilityEvidence, {
    addToCartButtonPresent: true,
    addToCartButtonDisabled: true,
    purchaseInfoBuyable: false,
    purchaseInfoIsBuyable: false,
    purchaseInfoAvailability: null,
    availabilityMetricZero: true,
    selectedSignal: 'add_to_cart_button',
  });
  assert.equal(detail.canonicalUrl, 'https://www.apple.com.cn/shop/product/g1cepch/a');
  assert.equal(detail.variations.length, 15);
  assert.ok(
    detail.variations.some(
      (variation) =>
        variation.productId === 'G1CE8CH/A' &&
        variation.memory === '512gb' &&
        variation.storage === '2tb',
    ),
  );
});

test('parseProductDetail treats an enabled add-to-cart button as available even if purchase JSON is stale', () => {
  const html = fs
    .readFileSync(path.join(fixturesDir, 'g1cepch-detail.html'), 'utf8')
    .replace('class="button button-block disabled"', 'class="button button-block"')
    .replace(' disabled="disabled" data-autom="add-to-cart"', ' data-autom="add-to-cart"');

  const detail = parseProductDetail(html, {
    url: 'https://www.apple.com.cn/shop/product/g1cepch/a',
  });

  assert.equal(detail.availabilityStatus, 'available');
  assert.deepEqual(detail.availabilityEvidence, {
    addToCartButtonPresent: true,
    addToCartButtonDisabled: false,
    purchaseInfoBuyable: false,
    purchaseInfoIsBuyable: false,
    purchaseInfoAvailability: null,
    availabilityMetricZero: true,
    selectedSignal: 'add_to_cart_button',
  });
});

test('canonicalizeAppleProductUrl removes Apple session query while preserving product identity', () => {
  assert.equal(
    canonicalizeAppleProductUrl('/shop/product/g1cepch/a?fnode=session-data', 'https://www.apple.com.cn'),
    'https://www.apple.com.cn/shop/product/g1cepch/a',
  );
});
