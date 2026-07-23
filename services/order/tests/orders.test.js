const {
  validateCreateOrderInput,
  computeTotal,
  isKnownStatus,
  canTransitionStatus,
  buildOrderFromInput,
} = require('../src/orders');

const validItems = [
  { productId: 'p1', name: 'Widget', unitPrice: 9.99, qty: 2 },
  { productId: 'p2', name: 'Gadget', unitPrice: 5, qty: 1 },
];

const validAddress = {
  line1: '123 Main St',
  city: 'Toronto',
  postalCode: 'M5V 2T6',
  country: 'CA',
};

function validBody(overrides = {}) {
  return {
    customerId: 'cust-1',
    items: validItems,
    shippingAddress: validAddress,
    ...overrides,
  };
}

describe('computeTotal', () => {
  it('sums unitPrice * qty across items', () => {
    expect(computeTotal(validItems)).toBeCloseTo(24.98, 2);
  });

  it('rounds to 2 decimal places', () => {
    const items = [{ productId: 'p1', name: 'x', unitPrice: 0.1, qty: 3 }];
    expect(computeTotal(items)).toBe(0.3);
  });

  it('returns 0 for an empty item list', () => {
    expect(computeTotal([])).toBe(0);
  });
});

describe('validateCreateOrderInput', () => {
  it('accepts a fully valid body', () => {
    expect(validateCreateOrderInput(validBody())).toBeNull();
  });

  it('rejects a missing body', () => {
    expect(validateCreateOrderInput(undefined)).toMatch(/JSON object/);
  });

  it('rejects a non-object body', () => {
    expect(validateCreateOrderInput('nope')).toMatch(/JSON object/);
  });

  it('rejects missing customerId', () => {
    const body = validBody({ customerId: undefined });
    expect(validateCreateOrderInput(body)).toMatch(/customerId/);
  });

  it('rejects an empty-string customerId', () => {
    const body = validBody({ customerId: '   ' });
    expect(validateCreateOrderInput(body)).toMatch(/customerId/);
  });

  it('rejects a non-array items', () => {
    const body = validBody({ items: {} });
    expect(validateCreateOrderInput(body)).toMatch(/items/);
  });

  it('rejects an empty items array', () => {
    const body = validBody({ items: [] });
    expect(validateCreateOrderInput(body)).toMatch(/items/);
  });

  it('rejects an item missing productId', () => {
    const body = validBody({
      items: [{ name: 'Widget', unitPrice: 1, qty: 1 }],
    });
    expect(validateCreateOrderInput(body)).toMatch(/items\[0\]\.productId/);
  });

  it('rejects an item missing name', () => {
    const body = validBody({
      items: [{ productId: 'p1', unitPrice: 1, qty: 1 }],
    });
    expect(validateCreateOrderInput(body)).toMatch(/items\[0\]\.name/);
  });

  it('rejects a negative unitPrice', () => {
    const body = validBody({
      items: [{ productId: 'p1', name: 'Widget', unitPrice: -1, qty: 1 }],
    });
    expect(validateCreateOrderInput(body)).toMatch(/items\[0\]\.unitPrice/);
  });

  it('rejects a non-finite unitPrice', () => {
    const body = validBody({
      items: [
        { productId: 'p1', name: 'Widget', unitPrice: Infinity, qty: 1 },
      ],
    });
    expect(validateCreateOrderInput(body)).toMatch(/items\[0\]\.unitPrice/);
  });

  it('rejects a non-integer qty', () => {
    const body = validBody({
      items: [{ productId: 'p1', name: 'Widget', unitPrice: 1, qty: 1.5 }],
    });
    expect(validateCreateOrderInput(body)).toMatch(/items\[0\]\.qty/);
  });

  it('rejects a qty less than 1', () => {
    const body = validBody({
      items: [{ productId: 'p1', name: 'Widget', unitPrice: 1, qty: 0 }],
    });
    expect(validateCreateOrderInput(body)).toMatch(/items\[0\]\.qty/);
  });

  it('rejects a missing shippingAddress', () => {
    const body = validBody({ shippingAddress: undefined });
    expect(validateCreateOrderInput(body)).toMatch(/shippingAddress/);
  });

  it.each(['line1', 'city', 'postalCode', 'country'])(
    'rejects a shippingAddress missing %s',
    (field) => {
      const address = { ...validAddress, [field]: '' };
      const body = validBody({ shippingAddress: address });
      expect(validateCreateOrderInput(body)).toMatch(
        new RegExp(`shippingAddress\\.${field}`)
      );
    }
  );
});

describe('isKnownStatus', () => {
  it.each(['PLACED', 'SHIPPED', 'DELIVERED', 'CANCELLED'])(
    'accepts %s',
    (status) => {
      expect(isKnownStatus(status)).toBe(true);
    }
  );

  it('rejects an unknown status', () => {
    expect(isKnownStatus('BOGUS')).toBe(false);
  });
});

describe('canTransitionStatus', () => {
  it('allows PLACED -> SHIPPED', () => {
    expect(canTransitionStatus('PLACED', 'SHIPPED')).toBe(true);
  });

  it('allows SHIPPED -> DELIVERED', () => {
    expect(canTransitionStatus('SHIPPED', 'DELIVERED')).toBe(true);
  });

  it('rejects PLACED -> DELIVERED (skipping SHIPPED)', () => {
    expect(canTransitionStatus('PLACED', 'DELIVERED')).toBe(false);
  });

  it('rejects any transition out of CANCELLED', () => {
    expect(canTransitionStatus('CANCELLED', 'SHIPPED')).toBe(false);
    expect(canTransitionStatus('CANCELLED', 'PLACED')).toBe(false);
  });

  it('rejects any transition out of DELIVERED', () => {
    expect(canTransitionStatus('DELIVERED', 'SHIPPED')).toBe(false);
  });

  it('rejects backward transitions', () => {
    expect(canTransitionStatus('SHIPPED', 'PLACED')).toBe(false);
  });
});

describe('buildOrderFromInput', () => {
  it('derives id, total, status, placedAt, deliveryEstimate, updatedAt server-side', () => {
    const order = buildOrderFromInput(validBody());

    expect(typeof order.id).toBe('string');
    expect(order.id.length).toBeGreaterThan(0);
    expect(order.status).toBe('PLACED');
    expect(order.total).toBeCloseTo(24.98, 2);
    expect(order.placedAt).toEqual(expect.any(String));
    expect(order.updatedAt).toBe(order.placedAt);
    expect(new Date(order.deliveryEstimate).getTime()).toBeGreaterThan(
      new Date(order.placedAt).getTime()
    );
  });

  it('sets deliveryEstimate to placedAt + 5 days', () => {
    const order = buildOrderFromInput(validBody());
    const placedAtMs = new Date(order.placedAt).getTime();
    const deliveryMs = new Date(order.deliveryEstimate).getTime();
    const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;

    expect(deliveryMs - placedAtMs).toBe(fiveDaysMs);
  });

  it('ignores client-supplied id/total/status/placedAt/deliveryEstimate/updatedAt', () => {
    const body = validBody({
      id: 'attacker-id',
      total: 0.01,
      status: 'DELIVERED',
      placedAt: '1999-01-01T00:00:00.000Z',
      deliveryEstimate: '1999-01-06T00:00:00.000Z',
      updatedAt: '1999-01-01T00:00:00.000Z',
    });

    const order = buildOrderFromInput(body);

    expect(order.id).not.toBe('attacker-id');
    expect(order.total).toBeCloseTo(24.98, 2);
    expect(order.status).toBe('PLACED');
    expect(order.placedAt).not.toBe('1999-01-01T00:00:00.000Z');
  });
});
