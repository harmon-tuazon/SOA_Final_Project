const request = require('supertest');

// Mock the DynamoDB document client so `npm test` never needs a live
// DynamoDB Local / AWS credentials (CI has neither). Variable names must be
// prefixed with "mock" so Jest allows referencing them inside the
// jest.mock() factory (which is hoisted above this file's top-level code).
const mockSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: () => ({ send: mockSend }),
    },
  };
});

const {
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

// eslint-disable-next-line global-require
const app = require('../src/app');

const validAddress = {
  line1: '123 Main St',
  city: 'Toronto',
  postalCode: 'M5V 2T6',
  country: 'CA',
};

function validCreateBody(overrides = {}) {
  return {
    customerId: 'cust-1',
    items: [
      { productId: 'p1', name: 'Widget', unitPrice: 9.99, qty: 2 },
      { productId: 'p2', name: 'Gadget', unitPrice: 5, qty: 1 },
    ],
    shippingAddress: validAddress,
    ...overrides,
  };
}

function makeOrder(overrides = {}) {
  return {
    id: 'order-1',
    customerId: 'cust-1',
    status: 'PLACED',
    items: [{ productId: 'p1', name: 'Widget', unitPrice: 9.99, qty: 2 }],
    total: 19.98,
    placedAt: '2026-01-01T00:00:00.000Z',
    shippingAddress: validAddress,
    deliveryEstimate: '2026-01-06T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockSend.mockReset();
});

describe('GET /orders', () => {
  it('returns the list sorted newest placedAt first', async () => {
    const older = makeOrder({ id: 'a', placedAt: '2026-01-01T00:00:00.000Z' });
    const newer = makeOrder({ id: 'b', placedAt: '2026-02-01T00:00:00.000Z' });

    mockSend.mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(ScanCommand);
      return { Items: [older, newer] };
    });

    const res = await request(app).get('/orders');

    expect(res.status).toBe(200);
    expect(res.body.map((o) => o.id)).toEqual(['b', 'a']);
  });

  it('filters by ?customerId= using a Scan FilterExpression', async () => {
    mockSend.mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(ScanCommand);
      expect(command.input.FilterExpression).toBe('customerId = :customerId');
      expect(command.input.ExpressionAttributeValues).toEqual({
        ':customerId': 'cust-1',
      });
      return { Items: [] };
    });

    const res = await request(app).get('/orders?customerId=cust-1');

    expect(res.status).toBe(200);
  });
});

describe('GET /orders/:id', () => {
  it('returns the order when found', async () => {
    const order = makeOrder();
    mockSend.mockResolvedValueOnce({ Item: order });

    const res = await request(app).get('/orders/order-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(order);
  });

  it('returns 404 when unknown', async () => {
    mockSend.mockResolvedValueOnce({});

    const res = await request(app).get('/orders/missing');

    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});

describe('POST /orders', () => {
  it('creates an order with a server-computed total and 201', async () => {
    mockSend.mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(PutCommand);
      return {};
    });

    const res = await request(app)
      .post('/orders')
      .send(validCreateBody());

    expect(res.status).toBe(201);
    expect(res.body.total).toBeCloseTo(24.98, 2);
    expect(res.body.status).toBe('PLACED');
    expect(typeof res.body.id).toBe('string');
  });

  it('strips an attacker-supplied total/status and stores the server-computed values', async () => {
    let putItem;
    mockSend.mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(PutCommand);
      putItem = command.input.Item;
      return {};
    });

    const res = await request(app)
      .post('/orders')
      .send(
        validCreateBody({
          total: 0.01,
          status: 'DELIVERED',
          id: 'attacker-id',
        })
      );

    expect(res.status).toBe(201);

    // The response reflects the server-derived record...
    expect(res.body.total).toBeCloseTo(24.98, 2);
    expect(res.body.status).toBe('PLACED');
    expect(res.body.id).not.toBe('attacker-id');

    // ...and so does what was actually persisted to DynamoDB.
    expect(putItem.total).toBeCloseTo(24.98, 2);
    expect(putItem.status).toBe('PLACED');
    expect(putItem.id).not.toBe('attacker-id');
  });

  it('returns 400 with a message naming the offending field on invalid body', async () => {
    const res = await request(app)
      .post('/orders')
      .send({ items: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customerId/);
  });

  it('returns 400 when an item has a non-integer qty', async () => {
    const res = await request(app)
      .post('/orders')
      .send(
        validCreateBody({
          items: [{ productId: 'p1', name: 'Widget', unitPrice: 1, qty: 1.5 }],
        })
      );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/qty/);
  });

  it('returns 400 when shippingAddress is missing a field', async () => {
    const res = await request(app)
      .post('/orders')
      .send(
        validCreateBody({ shippingAddress: { ...validAddress, city: '' } })
      );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/shippingAddress\.city/);
  });
});

describe('PATCH /orders/:id/status', () => {
  it('allows PLACED -> SHIPPED and returns 200', async () => {
    const order = makeOrder({ status: 'PLACED' });
    mockSend.mockImplementation(async (command) => {
      if (command instanceof GetCommand) return { Item: order };
      if (command instanceof UpdateCommand) return {};
      throw new Error(`unexpected command ${command.constructor.name}`);
    });

    const res = await request(app)
      .patch('/orders/order-1/status')
      .send({ status: 'SHIPPED' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SHIPPED');
  });

  it('allows SHIPPED -> DELIVERED and returns 200', async () => {
    const order = makeOrder({ status: 'SHIPPED' });
    mockSend.mockImplementation(async (command) => {
      if (command instanceof GetCommand) return { Item: order };
      if (command instanceof UpdateCommand) return {};
      throw new Error(`unexpected command ${command.constructor.name}`);
    });

    const res = await request(app)
      .patch('/orders/order-1/status')
      .send({ status: 'DELIVERED' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DELIVERED');
  });

  it('returns 409 on an illegal transition (PLACED -> DELIVERED)', async () => {
    const order = makeOrder({ status: 'PLACED' });
    mockSend.mockResolvedValueOnce({ Item: order });

    const res = await request(app)
      .patch('/orders/order-1/status')
      .send({ status: 'DELIVERED' });

    expect(res.status).toBe(409);
  });

  it('returns 409 when transitioning out of CANCELLED', async () => {
    const order = makeOrder({ status: 'CANCELLED' });
    mockSend.mockResolvedValueOnce({ Item: order });

    const res = await request(app)
      .patch('/orders/order-1/status')
      .send({ status: 'SHIPPED' });

    expect(res.status).toBe(409);
  });

  it('returns 404 for an unknown order', async () => {
    mockSend.mockResolvedValueOnce({});

    const res = await request(app)
      .patch('/orders/missing/status')
      .send({ status: 'SHIPPED' });

    expect(res.status).toBe(404);
  });

  it('returns 400 when status is missing', async () => {
    const res = await request(app).patch('/orders/order-1/status').send({});

    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 400 when status is not a known value', async () => {
    const res = await request(app)
      .patch('/orders/order-1/status')
      .send({ status: 'BOGUS' });

    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('POST /orders/:id/cancel', () => {
  it('cancels a PLACED order and returns 200', async () => {
    const order = makeOrder({ status: 'PLACED' });
    mockSend.mockImplementation(async (command) => {
      if (command instanceof GetCommand) return { Item: order };
      if (command instanceof UpdateCommand) return {};
      throw new Error(`unexpected command ${command.constructor.name}`);
    });

    const res = await request(app).post('/orders/order-1/cancel');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
  });

  it('returns 409 when cancelling a non-PLACED order', async () => {
    const order = makeOrder({ status: 'SHIPPED' });
    mockSend.mockResolvedValueOnce({ Item: order });

    const res = await request(app).post('/orders/order-1/cancel');

    expect(res.status).toBe(409);
  });

  it('returns 409 when cancelling an already-CANCELLED order', async () => {
    const order = makeOrder({ status: 'CANCELLED' });
    mockSend.mockResolvedValueOnce({ Item: order });

    const res = await request(app).post('/orders/order-1/cancel');

    expect(res.status).toBe(409);
  });

  it('returns 404 for an unknown order', async () => {
    mockSend.mockResolvedValueOnce({});

    const res = await request(app).post('/orders/missing/cancel');

    expect(res.status).toBe(404);
  });
});

describe('CORS', () => {
  it('answers OPTIONS preflight with 204', async () => {
    const res = await request(app).options('/orders');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('defaults Access-Control-Allow-Origin to * when unset', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });

    const res = await request(app).get('/orders');

    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

// --- Concurrency + query-param robustness (defects found in review) --------

/** Mimics the SDK's error when a write's ConditionExpression doesn't hold. */
function conditionFailure() {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

describe('concurrent status changes', () => {
  it('conditions the status update on the status it read', async () => {
    mockSend.mockResolvedValueOnce({ Item: makeOrder({ status: 'PLACED' }) });
    mockSend.mockResolvedValueOnce({});

    await request(app).patch('/orders/order-1/status').send({ status: 'SHIPPED' });

    const update = mockSend.mock.calls[1][0];
    expect(update).toBeInstanceOf(UpdateCommand);
    expect(update.input.ConditionExpression).toBe('#status = :expectedStatus');
    expect(update.input.ExpressionAttributeValues[':expectedStatus']).toBe('PLACED');
  });

  it('returns 409, not 500, when another writer wins the race on status', async () => {
    mockSend.mockResolvedValueOnce({ Item: makeOrder({ status: 'PLACED' }) });
    mockSend.mockRejectedValueOnce(conditionFailure());

    const res = await request(app)
      .patch('/orders/order-1/status')
      .send({ status: 'SHIPPED' });

    expect(res.status).toBe(409);
  });

  it('conditions cancel on the order still being PLACED at write time', async () => {
    mockSend.mockResolvedValueOnce({ Item: makeOrder({ status: 'PLACED' }) });
    mockSend.mockResolvedValueOnce({});

    await request(app).post('/orders/order-1/cancel');

    const update = mockSend.mock.calls[1][0];
    expect(update.input.ConditionExpression).toBe('#status = :expectedStatus');
    expect(update.input.ExpressionAttributeValues[':expectedStatus']).toBe('PLACED');
  });

  it('returns 409, not 500, when another writer wins the race on cancel', async () => {
    mockSend.mockResolvedValueOnce({ Item: makeOrder({ status: 'PLACED' }) });
    mockSend.mockRejectedValueOnce(conditionFailure());

    const res = await request(app).post('/orders/order-1/cancel');

    expect(res.status).toBe(409);
  });

  it('still returns 500 on a genuine DynamoDB failure', async () => {
    mockSend.mockResolvedValueOnce({ Item: makeOrder({ status: 'PLACED' }) });
    mockSend.mockRejectedValueOnce(new Error('network down'));

    const res = await request(app).post('/orders/order-1/cancel');

    expect(res.status).toBe(500);
  });
});

describe('GET /orders query params', () => {
  it('returns 400 when customerId is repeated, rather than 500', async () => {
    const res = await request(app).get('/orders?customerId=a&customerId=b');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customerId/);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
