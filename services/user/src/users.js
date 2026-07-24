// Pure user-domain logic: profile/billing validation, the PAN/CVV guard, and
// building server-authoritative records. No HTTP, no AWS SDK —
// unit-testable in isolation (per the PRD's testing requirement).

const CARD_BRANDS = ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER'];

// PRD §3.3 (binding): a body carrying raw card data must be rejected before
// it can reach the database or the logs. Two independent checks: a key name
// that smells like a PAN/CVV field, or a string value that is the right
// shape for a card number once spaces/dashes are stripped.
const FORBIDDEN_KEY_PATTERN = /^(card)?(number|pan|cvv|cvc|securitycode)$/i;
const DIGITS_13_TO_19 = /^\d{13,19}$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isString(value) {
  return typeof value === 'string';
}

function isIntegerInRange(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

// --- Profile -----------------------------------------------------------

/**
 * Validates a PUT /users/me request body. Only displayName/phone are
 * recognised — any other field is silently ignored by the caller, not
 * rejected here. Returns null when valid, or a string naming the offending
 * field.
 */
function validateProfileUpdateInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object';
  }
  if (Object.prototype.hasOwnProperty.call(body, 'displayName')) {
    const { displayName } = body;
    if (!isString(displayName) || displayName.length > 100) {
      return 'displayName must be a string of at most 100 characters';
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'phone')) {
    const { phone } = body;
    if (!isString(phone) || phone.length > 30) {
      return 'phone must be a string of at most 30 characters';
    }
  }
  return null;
}

/**
 * Picks only the editable profile fields (displayName, phone) present in
 * `body`, ignoring everything else — including any attempt to set userId or
 * email, which are never taken from the request body.
 */
function pickProfileUpdate(body) {
  const update = {};
  if (Object.prototype.hasOwnProperty.call(body, 'displayName')) {
    update.displayName = body.displayName;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'phone')) {
    update.phone = body.phone;
  }
  return update;
}

/**
 * Builds the initial profile record for a user's first upsert, from the
 * verified token's claims only — userId (sub) and email are never taken
 * from a request body.
 */
function buildProfileFromClaims({ sub, email }) {
  const now = new Date().toISOString();
  return {
    userId: sub,
    email,
    displayName: '',
    createdAt: now,
    updatedAt: now,
  };
}

// --- Billing -------------------------------------------------------------

function validateBillingAddress(address) {
  if (!address || typeof address !== 'object' || Array.isArray(address)) {
    return 'billingAddress is required and must be an object';
  }
  const requiredFields = ['line1', 'city', 'postalCode', 'country'];
  for (const field of requiredFields) {
    if (!isNonEmptyString(address[field])) {
      return `billingAddress.${field} is required and must be a non-empty string`;
    }
  }
  return null;
}

/**
 * Validates a PUT /users/me/billing request body against the shape in PRD
 * §3.1. The caller must run the PAN/CVV guard first — this function does
 * not check for raw card data, only shape.
 */
function validateBillingInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object';
  }
  if (!isNonEmptyString(body.cardholderName)) {
    return 'cardholderName is required and must be a non-empty string';
  }
  if (!CARD_BRANDS.includes(body.cardBrand)) {
    return `cardBrand must be one of ${CARD_BRANDS.join(', ')}`;
  }
  if (!isString(body.cardLast4) || !/^\d{4}$/.test(body.cardLast4)) {
    return 'cardLast4 must be a string of exactly 4 digits';
  }
  if (!isIntegerInRange(body.cardExpMonth, 1, 12)) {
    return 'cardExpMonth must be an integer between 1 and 12';
  }
  const currentYear = new Date().getFullYear();
  if (!isIntegerInRange(body.cardExpYear, currentYear, currentYear + 20)) {
    return `cardExpYear must be an integer between ${currentYear} and ${currentYear + 20}`;
  }
  if (!isNonEmptyString(body.paymentMethodToken)) {
    return 'paymentMethodToken is required and must be a non-empty string';
  }
  const addressError = validateBillingAddress(body.billingAddress);
  if (addressError) {
    return addressError;
  }
  return null;
}

/**
 * Builds the sanitized billing sub-object to persist — only the fields in
 * PRD §3.1's billing shape, nothing else from the request body.
 */
function buildBillingRecord(body) {
  return {
    cardholderName: body.cardholderName,
    cardBrand: body.cardBrand,
    cardLast4: body.cardLast4,
    cardExpMonth: body.cardExpMonth,
    cardExpYear: body.cardExpYear,
    paymentMethodToken: body.paymentMethodToken,
    billingAddress: {
      line1: body.billingAddress.line1,
      city: body.billingAddress.city,
      postalCode: body.billingAddress.postalCode,
      country: body.billingAddress.country,
    },
  };
}

// --- PAN/CVV guard (PRD §3.3, binding) ------------------------------------

/** True if `value`, once spaces/dashes are stripped, is 13-19 digits. */
function isForbiddenDigitString(value) {
  if (typeof value !== 'string') return false;
  const stripped = value.replace(/[\s-]/g, '');
  return DIGITS_13_TO_19.test(stripped);
}

/**
 * Recursively walks the entire request body (nested objects/arrays) and
 * returns true if it contains a PAN/CVV key or a value shaped like a raw
 * card number. Must be run — and must reject with 400 — before any write
 * and before any logging of the body.
 */
function containsForbiddenCardData(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenCardData(item));
  }
  if (typeof value === 'object') {
    return Object.entries(value).some(([key, val]) => {
      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        return true;
      }
      return containsForbiddenCardData(val);
    });
  }
  if (typeof value === 'string') {
    return isForbiddenDigitString(value);
  }
  return false;
}

module.exports = {
  CARD_BRANDS,
  validateProfileUpdateInput,
  pickProfileUpdate,
  buildProfileFromClaims,
  validateBillingInput,
  buildBillingRecord,
  containsForbiddenCardData,
};
