const {
  isValidStockDelta,
  roundPrice,
  validateCreateProductInput,
  validatePatchProductInput,
  buildProductFromInput,
  buildProductPatch,
} = require('../src/products');

function validBody(overrides = {}) {
  return {
    name: 'Widget',
    description: 'A fine widget',
    price: 9.999,
    category: 'Tools',
    imageUrl: 'https://example.com/widget.png',
    stock: 5,
    rating: 4.5,
    ...overrides,
  };
}

describe('roundPrice', () => {
  it('rounds to 2 decimal places', () => {
    expect(roundPrice(9.999)).toBe(10);
    expect(roundPrice(1.005)).toBeCloseTo(1, 2);
    expect(roundPrice(3)).toBe(3);
  });
});

describe('validateCreateProductInput', () => {
  it('accepts a fully valid body', () => {
    expect(validateCreateProductInput(validBody())).toBeNull();
  });

  it('accepts a body with only the required fields', () => {
    expect(
      validateCreateProductInput({ name: 'Widget', price: 1, category: 'Tools' })
    ).toBeNull();
  });

  it('rejects a missing body', () => {
    expect(validateCreateProductInput(undefined)).toMatch(/JSON object/);
  });

  it('rejects a non-object body', () => {
    expect(validateCreateProductInput('nope')).toMatch(/JSON object/);
  });

  it('rejects a missing name', () => {
    const body = validBody({ name: undefined });
    expect(validateCreateProductInput(body)).toMatch(/name/);
  });

  it('rejects an empty-string name', () => {
    const body = validBody({ name: '   ' });
    expect(validateCreateProductInput(body)).toMatch(/name/);
  });

  it('rejects a name over 200 characters', () => {
    const body = validBody({ name: 'x'.repeat(201) });
    expect(validateCreateProductInput(body)).toMatch(/name/);
  });

  it('rejects a description over 2000 characters', () => {
    const body = validBody({ description: 'x'.repeat(2001) });
    expect(validateCreateProductInput(body)).toMatch(/description/);
  });

  it('rejects a missing price', () => {
    const body = validBody({ price: undefined });
    expect(validateCreateProductInput(body)).toMatch(/price/);
  });

  it('rejects a negative price', () => {
    const body = validBody({ price: -1 });
    expect(validateCreateProductInput(body)).toMatch(/price/);
  });

  it('rejects a non-finite price', () => {
    const body = validBody({ price: Infinity });
    expect(validateCreateProductInput(body)).toMatch(/price/);
  });

  it('rejects a missing category', () => {
    const body = validBody({ category: undefined });
    expect(validateCreateProductInput(body)).toMatch(/category/);
  });

  it('rejects an empty-string category', () => {
    const body = validBody({ category: '' });
    expect(validateCreateProductInput(body)).toMatch(/category/);
  });

  it('rejects a category over 60 characters', () => {
    const body = validBody({ category: 'x'.repeat(61) });
    expect(validateCreateProductInput(body)).toMatch(/category/);
  });

  it('rejects a non-http(s) imageUrl', () => {
    const body = validBody({ imageUrl: 'ftp://example.com/x.png' });
    expect(validateCreateProductInput(body)).toMatch(/imageUrl/);
  });

  it('rejects an imageUrl with no scheme', () => {
    const body = validBody({ imageUrl: 'example.com/x.png' });
    expect(validateCreateProductInput(body)).toMatch(/imageUrl/);
  });

  it('accepts an http:// imageUrl', () => {
    const body = validBody({ imageUrl: 'http://example.com/x.png' });
    expect(validateCreateProductInput(body)).toBeNull();
  });

  it('rejects a non-integer stock', () => {
    const body = validBody({ stock: 1.5 });
    expect(validateCreateProductInput(body)).toMatch(/stock/);
  });

  it('rejects a negative stock', () => {
    const body = validBody({ stock: -1 });
    expect(validateCreateProductInput(body)).toMatch(/stock/);
  });

  it('rejects a rating above 5', () => {
    const body = validBody({ rating: 5.1 });
    expect(validateCreateProductInput(body)).toMatch(/rating/);
  });

  it('rejects a negative rating', () => {
    const body = validBody({ rating: -0.1 });
    expect(validateCreateProductInput(body)).toMatch(/rating/);
  });

  it('accepts a rating of exactly 0 and exactly 5', () => {
    expect(validateCreateProductInput(validBody({ rating: 0 }))).toBeNull();
    expect(validateCreateProductInput(validBody({ rating: 5 }))).toBeNull();
  });
});

describe('validatePatchProductInput', () => {
  it('accepts a single valid field', () => {
    expect(validatePatchProductInput({ price: 12.5 })).toBeNull();
  });

  it('accepts multiple valid fields', () => {
    expect(
      validatePatchProductInput({ name: 'New name', category: 'Electronics' })
    ).toBeNull();
  });

  it('rejects an empty object (no patchable fields)', () => {
    expect(validatePatchProductInput({})).toMatch(/at least one/);
  });

  it('rejects a body containing only non-patchable fields (id/createdAt/stock)', () => {
    expect(
      validatePatchProductInput({ id: 'x', createdAt: '1999-01-01', stock: 5 })
    ).toMatch(/at least one/);
  });

  it('rejects a missing body', () => {
    expect(validatePatchProductInput(undefined)).toMatch(/JSON object/);
  });

  it('rejects an invalid value for a present field', () => {
    expect(validatePatchProductInput({ price: -5 })).toMatch(/price/);
  });

  it('rejects an invalid rating', () => {
    expect(validatePatchProductInput({ rating: 9 })).toMatch(/rating/);
  });
});

describe('buildProductFromInput', () => {
  it('derives id/createdAt/updatedAt server-side and stores given fields', () => {
    const product = buildProductFromInput(validBody());

    expect(typeof product.id).toBe('string');
    expect(product.id.length).toBeGreaterThan(0);
    expect(product.name).toBe('Widget');
    expect(product.price).toBe(10);
    expect(product.category).toBe('Tools');
    expect(product.description).toBe('A fine widget');
    expect(product.imageUrl).toBe('https://example.com/widget.png');
    expect(product.stock).toBe(5);
    expect(product.rating).toBe(4.5);
    expect(product.createdAt).toEqual(expect.any(String));
    expect(product.updatedAt).toBe(product.createdAt);
  });

  it('defaults stock to 0 and rating to 0 when omitted', () => {
    const product = buildProductFromInput({
      name: 'Widget',
      price: 1,
      category: 'Tools',
    });

    expect(product.stock).toBe(0);
    expect(product.rating).toBe(0);
    expect(product.description).toBeUndefined();
    expect(product.imageUrl).toBeUndefined();
  });

  it('ignores a client-supplied id/createdAt/updatedAt', () => {
    const body = validBody({
      id: 'attacker',
      createdAt: '1999-01-01T00:00:00.000Z',
      updatedAt: '1999-01-01T00:00:00.000Z',
    });

    const product = buildProductFromInput(body);

    expect(product.id).not.toBe('attacker');
    expect(product.createdAt).not.toBe('1999-01-01T00:00:00.000Z');
    expect(product.updatedAt).not.toBe('1999-01-01T00:00:00.000Z');
  });
});

describe('buildProductPatch', () => {
  it('includes only the patchable fields present in the body', () => {
    const patch = buildProductPatch({
      name: 'New name',
      id: 'attacker',
      createdAt: '1999-01-01',
      stock: 999,
    });

    expect(patch).toEqual({ name: 'New name' });
  });

  it('rounds price when present', () => {
    const patch = buildProductPatch({ price: 9.999 });
    expect(patch.price).toBe(10);
  });
});

describe('isValidStockDelta', () => {
  it('accepts positive and negative integers', () => {
    expect(isValidStockDelta(5)).toBe(true);
    expect(isValidStockDelta(-5)).toBe(true);
    expect(isValidStockDelta(0)).toBe(true);
  });

  it('rejects non-integers, missing, and non-numbers', () => {
    expect(isValidStockDelta(1.5)).toBe(false);
    expect(isValidStockDelta(undefined)).toBe(false);
    expect(isValidStockDelta('5')).toBe(false);
    expect(isValidStockDelta(NaN)).toBe(false);
  });
});
