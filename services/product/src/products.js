// Pure product-domain logic: validation and building the server-authoritative
// product record (create + patch). No HTTP, no AWS SDK — unit-testable in
// isolation (per the PRD's testing requirement), mirroring services/order.

const crypto = require('crypto');

const NAME_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 2000;
const CATEGORY_MAX_LENGTH = 60;
const RATING_MIN = 0;
const RATING_MAX = 5;
const DEFAULT_STOCK = 0;
const DEFAULT_RATING = 0;

// Fields a PATCH /products/:id may touch. id/createdAt/stock are
// deliberately excluded — id/createdAt are server-owned forever, and stock
// only ever changes through the atomic PATCH /products/:id/stock route.
const PATCHABLE_FIELDS = ['name', 'description', 'price', 'category', 'imageUrl', 'rating'];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isValidRating(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= RATING_MIN &&
    value <= RATING_MAX
  );
}

function isValidStock(value) {
  return Number.isInteger(value) && value >= 0;
}

function isValidImageUrl(value) {
  return typeof value === 'string' && /^https?:\/\/.+/i.test(value);
}

/** Rounds a price to 2 decimal places, the way order rounds totals. */
function roundPrice(price) {
  return Math.round(price * 100) / 100;
}

/**
 * Validates a single field shared by create and patch. `value` is assumed
 * to be present (callers check presence themselves for patch, since patch
 * fields are all optional).
 */
function validateField(field, value) {
  switch (field) {
    case 'name':
      if (!isNonEmptyString(value) || value.length > NAME_MAX_LENGTH) {
        return `name is required and must be a non-empty string of at most ${NAME_MAX_LENGTH} characters`;
      }
      return null;
    case 'description':
      if (typeof value !== 'string' || value.length > DESCRIPTION_MAX_LENGTH) {
        return `description must be a string of at most ${DESCRIPTION_MAX_LENGTH} characters`;
      }
      return null;
    case 'price':
      if (!isFiniteNonNegativeNumber(value)) {
        return 'price is required and must be a finite number >= 0';
      }
      return null;
    case 'category':
      if (!isNonEmptyString(value) || value.length > CATEGORY_MAX_LENGTH) {
        return `category is required and must be a non-empty string of at most ${CATEGORY_MAX_LENGTH} characters`;
      }
      return null;
    case 'imageUrl':
      if (!isValidImageUrl(value)) {
        return 'imageUrl must be a string starting with http:// or https://';
      }
      return null;
    case 'stock':
      if (!isValidStock(value)) {
        return 'stock must be an integer >= 0';
      }
      return null;
    case 'rating':
      if (!isValidRating(value)) {
        return `rating must be a number between ${RATING_MIN} and ${RATING_MAX}`;
      }
      return null;
    default:
      return null;
  }
}

/**
 * Validates a POST /products request body.
 * Returns null when valid, or a string naming the offending field.
 */
function validateCreateProductInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object';
  }

  const nameError = validateField('name', body.name);
  if (nameError) return nameError;

  if (body.description !== undefined) {
    const descriptionError = validateField('description', body.description);
    if (descriptionError) return descriptionError;
  }

  const priceError = validateField('price', body.price);
  if (priceError) return priceError;

  const categoryError = validateField('category', body.category);
  if (categoryError) return categoryError;

  if (body.imageUrl !== undefined) {
    const imageUrlError = validateField('imageUrl', body.imageUrl);
    if (imageUrlError) return imageUrlError;
  }

  if (body.stock !== undefined) {
    const stockError = validateField('stock', body.stock);
    if (stockError) return stockError;
  }

  if (body.rating !== undefined) {
    const ratingError = validateField('rating', body.rating);
    if (ratingError) return ratingError;
  }

  return null;
}

/**
 * Validates a PATCH /products/:id request body: only the patchable fields
 * that are present are checked, and at least one must be present. Any
 * client-sent id/createdAt/stock is silently ignored (not an error) —
 * stock only moves through PATCH /products/:id/stock.
 */
function validatePatchProductInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object';
  }

  const presentFields = PATCHABLE_FIELDS.filter((field) => body[field] !== undefined);

  if (presentFields.length === 0) {
    return `Patch must include at least one of: ${PATCHABLE_FIELDS.join(', ')}`;
  }

  for (const field of presentFields) {
    const error = validateField(field, body[field]);
    if (error) return error;
  }

  return null;
}

/**
 * Builds the full, server-authoritative product record from a validated
 * create request. Any client-supplied id/createdAt/updatedAt in `body` is
 * ignored — only the fields read here are trusted from the request.
 */
function buildProductFromInput(body) {
  const now = new Date().toISOString();

  const product = {
    id: crypto.randomUUID(),
    name: body.name,
    price: roundPrice(body.price),
    category: body.category,
    stock: body.stock !== undefined ? body.stock : DEFAULT_STOCK,
    rating: body.rating !== undefined ? body.rating : DEFAULT_RATING,
    createdAt: now,
    updatedAt: now,
  };

  // Optional attributes are only set when supplied, rather than stored as
  // `undefined`, which the DynamoDB document client rejects by default.
  if (body.description !== undefined) {
    product.description = body.description;
  }
  if (body.imageUrl !== undefined) {
    product.imageUrl = body.imageUrl;
  }

  return product;
}

/**
 * Builds the set of attributes a validated PATCH request should write —
 * only the patchable fields actually present in `body`, price rounded.
 * id/createdAt/stock are never included even if sent by the client.
 */
function buildProductPatch(body) {
  const patch = {};

  for (const field of PATCHABLE_FIELDS) {
    if (body[field] === undefined) continue;
    patch[field] = field === 'price' ? roundPrice(body.price) : body[field];
  }

  return patch;
}

/** Whether a PATCH /products/:id/stock delta is a well-formed request value. */
function isValidStockDelta(delta) {
  return Number.isInteger(delta);
}

module.exports = {
  PATCHABLE_FIELDS,
  isNonEmptyString,
  isFiniteNonNegativeNumber,
  isValidRating,
  isValidStock,
  isValidImageUrl,
  isValidStockDelta,
  roundPrice,
  validateCreateProductInput,
  validatePatchProductInput,
  buildProductFromInput,
  buildProductPatch,
};
