// Unit tests for the product-service client used by POST /orders. Mocks the
// injected `fetchImpl` — no real network, no AWS — per PRD
// docs/action_plan/platform/0012-service-discovery.md.

const {
  DEFAULT_TIMEOUT_MS,
  UNAVAILABLE_MESSAGE,
  validateItemsAgainstProductService,
} = require('../src/productClient');

const items = [
  { productId: 'p1', name: 'Widget', unitPrice: 9.99, qty: 2 },
  { productId: 'p2', name: 'Gadget', unitPrice: 5, qty: 1 },
];

function fetchReturning(status) {
  return jest.fn().mockResolvedValue({ status });
}

describe('validateItemsAgainstProductService', () => {
  it('returns null when every item resolves 200', async () => {
    const fetchImpl = fetchReturning(200);

    const result = await validateItemsAgainstProductService(items, {
      baseUrl: 'http://product:3000',
      fetchImpl,
    });

    expect(result).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://product:3000/products/p1',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('returns 400 naming the productId when an item is unknown (404)', async () => {
    const fetchImpl = jest.fn().mockImplementation(async (url) => {
      if (url.endsWith('/products/p2')) return { status: 404 };
      return { status: 200 };
    });

    const result = await validateItemsAgainstProductService(items, {
      baseUrl: 'http://product:3000',
      fetchImpl,
    });

    expect(result).toEqual({ status: 400, error: 'Unknown productId: p2' });
  });

  it('fails closed with 503 when the product service returns 5xx', async () => {
    const fetchImpl = fetchReturning(500);

    const result = await validateItemsAgainstProductService(items, {
      baseUrl: 'http://product:3000',
      fetchImpl,
    });

    expect(result).toEqual({ status: 503, error: UNAVAILABLE_MESSAGE });
  });

  it('fails closed with 503 on a network error', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await validateItemsAgainstProductService(items, {
      baseUrl: 'http://product:3000',
      fetchImpl,
    });

    expect(result).toEqual({ status: 503, error: UNAVAILABLE_MESSAGE });
  });

  it('fails closed with 503 on a timeout (fetch never resolves)', async () => {
    const fetchImpl = jest.fn().mockImplementation(
      (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })
    );

    const result = await validateItemsAgainstProductService(items, {
      baseUrl: 'http://product:3000',
      fetchImpl,
      timeoutMs: 10,
    });

    expect(result).toEqual({ status: 503, error: UNAVAILABLE_MESSAGE });
  });

  it('fails closed with 503 when PRODUCT_SERVICE_URL is not configured', async () => {
    const fetchImpl = jest.fn();

    const result = await validateItemsAgainstProductService(items, {
      baseUrl: '',
      fetchImpl,
    });

    expect(result).toEqual({ status: 503, error: UNAVAILABLE_MESSAGE });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exposes a sane default timeout in the 2-3s range', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(2000);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });
});
