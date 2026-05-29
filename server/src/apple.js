const APPLE_BASE_URL = 'https://www.apple.com.cn';

function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\u200d/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtmlText(value) {
  return normalizeWhitespace(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function parseAttributes(rawAttributes) {
  const attributes = {};
  const attrPattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = attrPattern.exec(rawAttributes)) !== null) {
    const [, key, doubleQuoted, singleQuoted, bare] = match;
    attributes[key.toLowerCase()] = decodeHtmlText(doubleQuoted ?? singleQuoted ?? bare ?? '');
  }
  return attributes;
}

function extractJsonAssignmentText(html, assignmentName) {
  const assignmentIndex = html.indexOf(assignmentName);
  if (assignmentIndex === -1) {
    return null;
  }

  const equalsIndex = html.indexOf('=', assignmentIndex + assignmentName.length);
  const startIndex = html.indexOf('{', equalsIndex);
  if (equalsIndex === -1 || startIndex === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < html.length; index += 1) {
    const char = html[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return html.slice(startIndex, index + 1);
      }
    }
  }

  throw new Error(`Unterminated JSON assignment: ${assignmentName}`);
}

function extractAssignedJson(html, assignmentName) {
  const jsonText = extractJsonAssignmentText(html, assignmentName);
  if (!jsonText) {
    return null;
  }
  return JSON.parse(jsonText);
}

function extractScriptJsonById(html, id) {
  const pattern = new RegExp(
    `<script\\b[^>]*\\bid=["']${escapeRegExp(id)}["'][^>]*>([\\s\\S]*?)<\\/script>`,
    'i',
  );
  const match = html.match(pattern);
  if (!match) {
    return null;
  }
  return JSON.parse(match[1]);
}

function canonicalizeAppleProductUrl(url, baseUrl = APPLE_BASE_URL) {
  const parsed = new URL(url, baseUrl);
  const productPath = parsed.pathname.match(/^(.*\/shop\/product\/)([^/]+)(\/a)(?:\/)?$/i);
  parsed.search = '';
  parsed.hash = '';

  if (!productPath) {
    return parsed.toString();
  }

  parsed.pathname = `${productPath[1]}${productPath[2].toLowerCase()}${productPath[3]}`;
  return parsed.toString();
}

function toAbsoluteUrl(url, baseUrl = APPLE_BASE_URL) {
  return new URL(url, baseUrl).toString();
}

function productPathFromPartNumber(partNumber) {
  return `/shop/product/${String(partNumber).toLowerCase()}`;
}

function inferBasePartNumber(partNumber) {
  const sku = String(partNumber ?? '').split('/')[0];
  return sku.replace(/CH$/i, '');
}

function dictionaryText(dictionaries, key, value) {
  if (!value) {
    return null;
  }
  return dictionaries?.dimensions?.[key]?.[value]?.text ?? null;
}

function fallbackDimensionText(value) {
  if (!value) {
    return null;
  }
  return String(value).replace('point', '.').replace('_', '.').toUpperCase();
}

function dimensionText(dictionaries, key, value, selectedText) {
  return selectedText || dictionaryText(dictionaries, key, value) || fallbackDimensionText(value);
}

function normalizePrice(price) {
  const currentPrice = price?.currentPrice ?? null;
  if (!currentPrice && typeof price?.fullPrice !== 'number') {
    return null;
  }

  if (currentPrice) {
    const raw = currentPrice.raw_amount ?? currentPrice.rawAmount;
    return {
      amount: currentPrice.amount ?? null,
      rawAmount: raw === undefined ? null : Number(raw),
      currency: price.priceCurrency ?? null,
    };
  }

  return {
    amount: null,
    rawAmount: Number(price.fullPrice),
    currency: null,
  };
}

function inferModelFromTitle(title) {
  const normalized = normalizeWhitespace(title).toLowerCase();
  const models = [
    ['mac studio', 'Mac Studio'],
    ['mac mini', 'Mac mini'],
    ['macbook pro', 'MacBook Pro'],
    ['macbook air', 'MacBook Air'],
    ['imac', 'iMac'],
    ['studio display', 'Studio Display'],
    ['mac pro', 'Mac Pro'],
  ];
  const found = models.find(([needle]) => normalized.includes(needle));
  return found?.[1] ?? null;
}

function parseCoreCount(title, chinesePattern, englishPattern) {
  const normalized = normalizeWhitespace(title);
  const chineseMatch = normalized.match(chinesePattern);
  if (chineseMatch) {
    return Number(chineseMatch[1]);
  }
  const englishMatch = normalized.match(englishPattern);
  if (englishMatch) {
    return Number(englishMatch[1]);
  }
  return null;
}

function extractTitleMetadata(title) {
  const normalized = normalizeWhitespace(title).replace(/\u2011|\u2010|\u2013|\u2014/g, '-');
  const chipMatch = normalized.match(/Apple\s+(M\d(?:\s*(?:Ultra|Max|Pro))?)\s+(?:芯片|chip)/i);

  return {
    model: inferModelFromTitle(normalized),
    chip: chipMatch ? normalizeWhitespace(chipMatch[1]).replace(/\s+/g, ' ') : null,
    cpuCores: parseCoreCount(
      normalized,
      /(\d+)\s*核\s*中央处理器/,
      /(\d+)\s*-?\s*Core\s*CPU/i,
    ),
    gpuCores: parseCoreCount(
      normalized,
      /(\d+)\s*核\s*图形处理器/,
      /(\d+)\s*-?\s*Core\s*GPU/i,
    ),
  };
}

function parseRefurbGridBootstrap(html) {
  return extractAssignedJson(html, 'window.REFURB_GRID_BOOTSTRAP');
}

function buildListingOffer(tile, dictionaries, baseUrl) {
  const dimensions = tile.filters?.dimensions ?? {};
  const title = normalizeWhitespace(tile.title);
  const titleMetadata = extractTitleMetadata(title);
  const productId = tile.partNumber ?? tile.price?.partNumber ?? tile.omnitureModel?.partNumber ?? null;
  const url = tile.productDetailsUrl ? toAbsoluteUrl(tile.productDetailsUrl, baseUrl) : null;
  const model =
    dictionaryText(dictionaries, 'refurbClearModel', dimensions.refurbClearModel) ??
    titleMetadata.model;
  const memory = dimensions.dimensionMemory ?? dimensions.tsMemorySize ?? null;
  const storage = dimensions.dimensionCapacity ?? null;

  return {
    source: 'listing',
    productId,
    basePartNumber:
      tile.omnitureModel?.basePartNumber ?? tile.price?.basePartNumber ?? inferBasePartNumber(productId),
    title,
    model,
    chip: titleMetadata.chip,
    cpuCores: titleMetadata.cpuCores,
    gpuCores: titleMetadata.gpuCores,
    memory,
    memoryText: dimensionText(dictionaries, 'tsMemorySize', memory),
    storage,
    storageText: dimensionText(dictionaries, 'dimensionCapacity', storage),
    price: normalizePrice(tile.price),
    url,
    canonicalUrl: url ? canonicalizeAppleProductUrl(url, baseUrl) : null,
    imageUrl: tile.image?.sources?.[0]?.srcSet ?? null,
    availabilityStatus: 'available',
  };
}

function parseRefurbListings(html, options = {}) {
  const baseUrl = options.baseUrl ?? APPLE_BASE_URL;
  const bootstrap = parseRefurbGridBootstrap(html);
  if (!bootstrap?.tiles) {
    return [];
  }

  const offers = bootstrap.tiles
    .map((tile) => buildListingOffer(tile, bootstrap.dictionaries, baseUrl))
    .filter((offer) => offer.productId && offer.url);

  if (!options.model) {
    return offers;
  }

  const expectedModel = normalizeWhitespace(options.model).toLowerCase();
  return offers.filter((offer) => normalizeWhitespace(offer.model).toLowerCase() === expectedModel);
}

function parseSelectedSelects(html) {
  const selected = {};
  const selectPattern = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let selectMatch;

  while ((selectMatch = selectPattern.exec(html)) !== null) {
    const selectAttributes = parseAttributes(selectMatch[1]);
    const name = selectAttributes.name || selectAttributes.id;
    if (!name) {
      continue;
    }

    const optionPattern = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    let optionMatch;
    while ((optionMatch = optionPattern.exec(selectMatch[2])) !== null) {
      const optionAttributes = parseAttributes(optionMatch[1]);
      if (!Object.prototype.hasOwnProperty.call(optionAttributes, 'selected')) {
        continue;
      }

      selected[name] = {
        value: optionAttributes.value ?? decodeHtmlText(optionMatch[2]),
        text: decodeHtmlText(optionMatch[2]),
      };
      break;
    }
  }

  return selected;
}

function extractCanonicalLink(html) {
  const match = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i);
  return match ? decodeHtmlText(match[1]) : null;
}

function extractMetaContent(html, propertyName) {
  const pattern = new RegExp(
    `<meta\\b[^>]*(?:property|name)=["']${escapeRegExp(propertyName)}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    'i',
  );
  const match = html.match(pattern);
  return match ? decodeHtmlText(match[1]) : null;
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function extractAddToCartButtonAttributes(html) {
  const addToCartButton = html.match(/<button\b[^>]*data-autom=["']add-to-cart["'][^>]*>/i)?.[0];
  return addToCartButton ? parseAttributes(addToCartButton) : null;
}

function buildAvailabilityEvidence(html, purchaseInfo) {
  const addToCartAttributes = extractAddToCartButtonAttributes(html);
  const addToCartButtonPresent = Boolean(addToCartAttributes);
  const addToCartButtonDisabled = addToCartAttributes
    ? Object.prototype.hasOwnProperty.call(addToCartAttributes, 'disabled') ||
      /\bdisabled\b/i.test(addToCartAttributes.class || '') ||
      String(addToCartAttributes['aria-disabled'] || '').toLowerCase() === 'true'
    : null;
  const purchaseInfoBuyable = booleanOrNull(purchaseInfo?.buyable);
  const purchaseInfoIsBuyable = booleanOrNull(purchaseInfo?.isBuyable);
  const purchaseInfoAvailability = booleanOrNull(purchaseInfo?.availability);
  const availabilityMetricZero = /Availability\s*\|\s*0\s*\|/i.test(html);
  let selectedSignal = 'unknown';

  if (addToCartButtonPresent) {
    selectedSignal = 'add_to_cart_button';
  } else if (purchaseInfoIsBuyable !== null || purchaseInfoBuyable !== null) {
    selectedSignal = 'purchase_info';
  } else if (availabilityMetricZero) {
    selectedSignal = 'availability_metric';
  }

  return {
    addToCartButtonPresent,
    addToCartButtonDisabled,
    purchaseInfoBuyable,
    purchaseInfoIsBuyable,
    purchaseInfoAvailability,
    availabilityMetricZero,
    selectedSignal,
  };
}

function inferAvailabilityStatus(html, purchaseInfo, evidence = buildAvailabilityEvidence(html, purchaseInfo)) {
  const addToCartButton = html.match(/<button\b[^>]*data-autom=["']add-to-cart["'][^>]*>/i)?.[0];
  if (addToCartButton) {
    return evidence.addToCartButtonDisabled ? 'unavailable' : 'available';
  }

  if (purchaseInfo?.isBuyable === true || purchaseInfo?.buyable === true) {
    return 'available';
  }
  if (purchaseInfo?.isBuyable === false || purchaseInfo?.buyable === false) {
    return 'unavailable';
  }

  if (/Availability\s*\|\s*0\s*\|/i.test(html)) {
    return 'unavailable';
  }
  return 'unknown';
}

function parseProductVariations(pdpContent, baseUrl) {
  if (!pdpContent?.productVariationsPart) {
    return [];
  }

  const variationMap = JSON.parse(pdpContent.productVariationsPart).productVariations ?? {};
  return Object.entries(variationMap).map(([productId, variation]) => {
    const title = normalizeWhitespace(variation.productTitle);
    const titleMetadata = extractTitleMetadata(title);
    const url = toAbsoluteUrl(productPathFromPartNumber(productId), baseUrl);

    return {
      source: 'detailVariation',
      productId,
      basePartNumber: inferBasePartNumber(productId),
      title,
      model: titleMetadata.model,
      chip: titleMetadata.chip,
      cpuCores: titleMetadata.cpuCores,
      gpuCores: titleMetadata.gpuCores,
      memory: variation.dimensionMemory ?? null,
      memoryText: fallbackDimensionText(variation.dimensionMemory),
      storage: variation.dimensionCapacity ?? null,
      storageText: fallbackDimensionText(variation.dimensionCapacity),
      year: variation.dimensionRelYear ?? null,
      url,
      canonicalUrl: canonicalizeAppleProductUrl(url, baseUrl),
    };
  });
}

function parseProductDetail(html, options = {}) {
  const baseUrl = options.baseUrl ?? APPLE_BASE_URL;
  const metrics = extractScriptJsonById(html, 'metrics');
  const pdpContent = extractAssignedJson(html, 'window.pageLevelData.PDPContent') ?? {};
  const purchaseInfo = pdpContent.purchaseInfo ?? {};
  const metricsProduct = metrics?.data?.products?.[0] ?? {};
  const selectedOptions = parseSelectedSelects(html);
  const canonicalLink = extractCanonicalLink(html) ?? options.url ?? null;
  const canonicalUrl = canonicalLink ? canonicalizeAppleProductUrl(canonicalLink, baseUrl) : null;
  const title = normalizeWhitespace(
    pdpContent.productTitle ??
      extractMetaContent(html, 'og:title') ??
      metricsProduct.name ??
      '',
  );
  const titleMetadata = extractTitleMetadata(title);
  const productId =
    purchaseInfo.partNumber ??
    metricsProduct.partNumber ??
    html.match(/name=["']product["']\s+value=["']([^"']+)["']/i)?.[1] ??
    null;
  const memory = selectedOptions.dimensionMemory?.value ?? null;
  const storage = selectedOptions.dimensionCapacity?.value ?? null;
  const price = normalizePrice(purchaseInfo.price) ?? normalizePrice(metricsProduct.price);
  const availabilityEvidence = buildAvailabilityEvidence(html, purchaseInfo);

  return {
    source: 'detail',
    productId,
    basePartNumber: inferBasePartNumber(productId),
    title,
    model: titleMetadata.model,
    chip: titleMetadata.chip,
    cpuCores: titleMetadata.cpuCores,
    gpuCores: titleMetadata.gpuCores,
    memory,
    memoryText: selectedOptions.dimensionMemory?.text ?? fallbackDimensionText(memory),
    storage,
    storageText: selectedOptions.dimensionCapacity?.text ?? fallbackDimensionText(storage),
    selectedOptions,
    price,
    url: options.url ? toAbsoluteUrl(options.url, baseUrl) : canonicalUrl,
    canonicalUrl,
    availabilityStatus: inferAvailabilityStatus(html, purchaseInfo, availabilityEvidence),
    availabilityEvidence,
    variations: parseProductVariations(pdpContent, baseUrl),
  };
}

module.exports = {
  canonicalizeAppleProductUrl,
  extractAssignedJson,
  extractTitleMetadata,
  normalizeWhitespace,
  parseProductDetail,
  parseRefurbGridBootstrap,
  parseRefurbListings,
};
