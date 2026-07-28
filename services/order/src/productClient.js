// Read-only client for the product service, called from POST /orders to
// validate that every line item's productId is real before the order is
// persisted. Reached over ECS Service Connect by logical name — see PRD
// docs/action_plan/platform/0012-service-discovery.md. Never writes/decrements
// stock; that stays out of scope (distributed-transaction territory).
//
// No HTTP framework dependency: uses the Node 18+ global `fetch` (the
// service images run node:20-alpine), so no new package is needed.

// Service Connect's Envoy proxy retries at the network layer, but the app
// still needs a sane upper bound so a hung product service can't hang order
// creation indefinitely.
const DEFAULT_TIMEOUT_MS = 2500;

const UNAVAILABLE_MESSAGE = 'Product service unavailable, please try again';

/** Reads the product service base URL from the environment. Never hardcoded. */
function getProductServiceUrl() {
  return process.env.PRODUCT_SERVICE_URL;
}

/**
 * Checks a single productId against `GET {baseUrl}/products/:id`.
 * Returns one of:
 *  - { ok: true }                       product exists (200)
 *  - { ok: false, code: 'NOT_FOUND' }    product doesn't exist (404)
 *  - { ok: false, code: 'UNAVAILABLE' }  timeout, network error, or any
 *                                        other non-200/404 response (incl. 5xx)
 */
async function checkProductExists(productId, { baseUrl, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(`${baseUrl}/products/${encodeURIComponent(productId)}`, {
      method: 'GET',
      signal: controller.signal,
    });

    if (res.status === 200) {
      return { ok: true };
    }
    if (res.status === 404) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    // Any other status (5xx, unexpected 4xx) is treated the same as
    // unreachable: we can't confirm the product exists, so fail closed.
    return { ok: false, code: 'UNAVAILABLE' };
  } catch (err) {
    // Network error or abort (timeout) — fail closed.
    return { ok: false, code: 'UNAVAILABLE' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validates every order line item's productId against the product service.
 *
 * Returns `null` when every item validates (200 from product). Otherwise
 * returns `{ status, error }` describing the first failure to surface to
 * the client:
 *  - `{ status: 400, error: '...productId...' }` — an item's product is
 *    unknown (404) or the base URL isn't configured; reject the order.
 *  - `{ status: 503, error: '...unavailable...' }` — the product service
 *    timed out, errored, or returned a 5xx; fail closed rather than saving
 *    an order that might reference a nonexistent product.
 *
 * `fetchImpl` is injectable for tests; defaults to the Node global `fetch`.
 */
async function validateItemsAgainstProductService(items, options = {}) {
  const baseUrl = options.baseUrl !== undefined ? options.baseUrl : getProductServiceUrl();
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl || fetch;

  if (!baseUrl) {
    // No product service configured for this environment — validation is
    // unavailable. Fail closed: we cannot confirm the products are real, so
    // we must not save the order.
    return { status: 503, error: UNAVAILABLE_MESSAGE };
  }

  const results = await Promise.all(
    items.map((item) => checkProductExists(item.productId, { baseUrl, timeoutMs, fetchImpl }))
  );

  const notFoundIndex = results.findIndex((r) => !r.ok && r.code === 'NOT_FOUND');
  if (notFoundIndex !== -1) {
    return {
      status: 400,
      error: `Unknown productId: ${items[notFoundIndex].productId}`,
    };
  }

  const anyUnavailable = results.some((r) => !r.ok && r.code === 'UNAVAILABLE');
  if (anyUnavailable) {
    return { status: 503, error: UNAVAILABLE_MESSAGE };
  }

  return null;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  UNAVAILABLE_MESSAGE,
  getProductServiceUrl,
  validateItemsAgainstProductService,
};
