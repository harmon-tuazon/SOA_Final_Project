// Pure order-domain logic: validation, total computation, status transition
// rules, and building the server-authoritative order record. No HTTP, no
// AWS SDK — unit-testable in isolation (per the PRD's testing requirement).

const crypto = require('crypto');

const STATUSES = ['PLACED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

// Legal forward transitions for PATCH /orders/:id/status. Anything not
// listed here (including transitions out of CANCELLED or DELIVERED) is
// illegal and must be rejected with 409 by the caller.
const ALLOWED_TRANSITIONS = {
  PLACED: 'SHIPPED',
  SHIPPED: 'DELIVERED',
};

const DELIVERY_ESTIMATE_DAYS = 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function validateItem(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return `items[${index}] must be an object`;
  }
  if (!isNonEmptyString(item.productId)) {
    return `items[${index}].productId is required and must be a non-empty string`;
  }
  if (!isNonEmptyString(item.name)) {
    return `items[${index}].name is required and must be a non-empty string`;
  }
  if (!isFiniteNonNegativeNumber(item.unitPrice)) {
    return `items[${index}].unitPrice must be a finite number >= 0`;
  }
  if (!isPositiveInteger(item.qty)) {
    return `items[${index}].qty must be an integer >= 1`;
  }
  return null;
}

function validateShippingAddress(address) {
  if (!address || typeof address !== 'object' || Array.isArray(address)) {
    return 'shippingAddress is required and must be an object';
  }
  const requiredFields = ['line1', 'city', 'postalCode', 'country'];
  for (const field of requiredFields) {
    if (!isNonEmptyString(address[field])) {
      return `shippingAddress.${field} is required and must be a non-empty string`;
    }
  }
  return null;
}

/**
 * Validates a POST /orders request body.
 * Returns null when valid, or a string naming the offending field.
 */
function validateCreateOrderInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object';
  }
  if (!isNonEmptyString(body.customerId)) {
    return 'customerId is required and must be a non-empty string';
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return 'items is required and must be a non-empty array';
  }
  for (let i = 0; i < body.items.length; i += 1) {
    const itemError = validateItem(body.items[i], i);
    if (itemError) {
      return itemError;
    }
  }
  const addressError = validateShippingAddress(body.shippingAddress);
  if (addressError) {
    return addressError;
  }
  return null;
}

/** Sum of unitPrice * qty across items, rounded to 2 decimal places. */
function computeTotal(items) {
  const rawTotal = items.reduce(
    (sum, item) => sum + item.unitPrice * item.qty,
    0
  );
  return Math.round(rawTotal * 100) / 100;
}

function isKnownStatus(status) {
  return STATUSES.includes(status);
}

/** Whether `from` -> `to` is a legal PATCH /orders/:id/status transition. */
function canTransitionStatus(from, to) {
  return ALLOWED_TRANSITIONS[from] === to;
}

/**
 * Builds the full, server-authoritative order record from a validated
 * create request. Any client-supplied id/status/total/placedAt/
 * deliveryEstimate/updatedAt in `body` is ignored — only the fields read
 * here (customerId, items, shippingAddress) are trusted from the request.
 */
function buildOrderFromInput(body) {
  const now = new Date();
  const placedAt = now.toISOString();
  const deliveryEstimate = new Date(
    now.getTime() + DELIVERY_ESTIMATE_DAYS * MS_PER_DAY
  ).toISOString();

  const items = body.items.map((item) => ({
    productId: item.productId,
    name: item.name,
    unitPrice: item.unitPrice,
    qty: item.qty,
  }));

  return {
    id: crypto.randomUUID(),
    customerId: body.customerId,
    status: 'PLACED',
    items,
    total: computeTotal(items),
    placedAt,
    shippingAddress: {
      line1: body.shippingAddress.line1,
      city: body.shippingAddress.city,
      postalCode: body.shippingAddress.postalCode,
      country: body.shippingAddress.country,
    },
    deliveryEstimate,
    updatedAt: placedAt,
  };
}

module.exports = {
  STATUSES,
  ALLOWED_TRANSITIONS,
  validateCreateOrderInput,
  computeTotal,
  isKnownStatus,
  canTransitionStatus,
  buildOrderFromInput,
};
