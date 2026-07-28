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
  DeleteCommand,
} = require('@aws-sdk/lib-dynamodb');

// eslint-disable-next-line global-require
const app = require('../src/app');

function validCreateBody(overrides = {}) {
  return {
    name: 'Widget',
    description: 'A fine widget',
    price: 9.99,
    category: 'Tools',
    imageUrl: 'https://example.com/widget.png',
    stock: 5,
    rating: 4.5,
    ...overrides,
  };
}

function makeProduct(overrides = {}) {
  return {
    id: 'prod-1',
    name: 'Widget',
    description: 'A fine widget',
    price: 9.99,
    category: 'Tools',
    imageUrl: 'https://example.com/widget.png',
    stock: 5,
    rating: 4.5,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockSend.mockReset();
});

/** Mimics the SDK's error when a write's ConditionExpression doesn't hold. */
function conditionFailure() {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

describe('GET /products', () => {
  it('returns the list sorted newest createdAt first', async () => {
    const older = makeProduct({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = makeProduct({ id: 'b', createdAt: '2026-02-01T00:00:00.000Z' });

    mockSend.mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(ScanCommand);
      return { Items: [older, newer] };
    });

    const res = await request(app).get('/products');

    expect(res.status).toBe(200);
    expect(res.body.map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('filters by ?category= using a Scan FilterExpression', async () => {
    mockSend.mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(ScanCommand);
      expect(command.input.FilterExpression).toBe('category = :category');
      expect(command.input.ExpressionAttributeValues).toEqual({
        ':category': 'Tools',
      });
      return { Items: [] };
    });

    const res = await request(app).get('/products?category=Tools');

    expect(res.status).toBe(200);
  });

  it('filters by ?q= case-insensitively against name and description', async () => {
    const match = makeProduct({ id: 'a', name: 'Blue Widget' });
    const noMatch = makeProduct({ id: 'b', name: 'Gadget', description: 'unrelated' });

    mockSend.mockResolvedValueOnce({ Items: [match, noMatch] });

    const res = await request(app).get('/products?q=WIDGET');

    expect(res.status).toBe(200);
    expect(res.body.map((p) => p.id)).toEqual(['a']);
  });

  it('matches ?q= against description too', async () => {
    const match = makeProduct({ id: 'a', name: 'Gadget', description: 'a shiny widget' });
    const noMatch = makeProduct({ id: 'b', name: 'Gizmo', description: 'nothing special' });

    mockSend.mockResolvedValueOnce({ Items: [match, noMatch] });

    const res = await request(app).get('/products?q=widget');

    expect(res.status).toBe(200);
    expect(res.body.map((p) => p.id)).toEqual(['a']);
  });

  it('combines ?category= and ?q=', async () => {
    mockSend.mockImplementation(async (command) => {
      expect(command.input.FilterExpression).toBe('category = :category');
      return {
        Items: [
          makeProduct({ id: 'a', category: 'Tools', name: 'Blue Widget' }),
          makeProduct({ id: 'b', category: 'Tools', name: 'Gadget', description: 'unrelated' }),
        ],
      };
    });

    const res = await request(app).get('/products?category=Tools&q=widget');

    expect(res.status).toBe(200);
    expect(res.body.map((p) => p.id)).toEqual(['a']);
  });

  it('returns 400 when category is repeated, rather than 500', async () => {
    const res = await request(app).get('/products?category=a&category=b');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/category/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 400 when q is repeated, rather than 500', async () => {
    const res = await request(app).get('/products?q=a&q=b');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/q/);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('GET /products/:id', () => {
  it('returns the product when found', async () => {
    const product = makeProduct();
    mockSend.mockResolvedValueOnce({ Item: product });

    const res = await request(app).get('/products/prod-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(product);
  });

  it('returns 404 when unknown', async () => {
    mockSend.mockResolvedValueOnce({});

    const res = await request(app).get('/products/missing');

    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});

describe('POST /products', () => {
  it('creates a product with server-derived fields and 201', async () => {
    mockSend.mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(PutCommand);
      return {};
    });

    const res = await request(app).post('/products').send(validCreateBody());

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Widget');
    expect(typeof res.body.id).toBe('string');
    expect(res.body.createdAt).toEqual(expect.any(String));
  });

  it('strips attacker-supplied id/createdAt/updatedAt and stores server values', async () => {
    let putItem;
    mockSend.mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(PutCommand);
      putItem = command.input.Item;
      return {};
    });

    const res = await request(app)
      .post('/products')
      .send(
        validCreateBody({
          id: 'attacker',
          createdAt: '1999-01-01T00:00:00.000Z',
          updatedAt: '1999-01-01T00:00:00.000Z',
        })
      );

    expect(res.status).toBe(201);

    // The response reflects the server-derived record...
    expect(res.body.id).not.toBe('attacker');
    expect(res.body.createdAt).not.toBe('1999-01-01T00:00:00.000Z');
    expect(res.body.updatedAt).not.toBe('1999-01-01T00:00:00.000Z');

    // ...and so does what was actually persisted to DynamoDB.
    expect(putItem.id).not.toBe('attacker');
    expect(putItem.createdAt).not.toBe('1999-01-01T00:00:00.000Z');
    expect(putItem.updatedAt).not.toBe('1999-01-01T00:00:00.000Z');
  });

  it('returns 400 with a message naming the offending field on invalid body', async () => {
    const res = await request(app).post('/products').send({ price: 1, category: 'Tools' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 400 on a negative price', async () => {
    const res = await request(app)
      .post('/products')
      .send(validCreateBody({ price: -1 }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/price/);
  });

  it('returns 400 on a bad imageUrl', async () => {
    const res = await request(app)
      .post('/products')
      .send(validCreateBody({ imageUrl: 'not-a-url' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/imageUrl/);
  });

  it('returns 400 when rating is above 5', async () => {
    const res = await request(app)
      .post('/products')
      .send(validCreateBody({ rating: 6 }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rating/);
  });

  it('returns 400 on a non-integer stock', async () => {
    const res = await request(app)
      .post('/products')
      .send(validCreateBody({ stock: 1.5 }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/stock/);
  });
});

describe('PATCH /products/:id', () => {
  it('updates allowed fields via a single conditional UpdateCommand and returns 200', async () => {
    const updated = makeProduct({ name: 'New name', updatedAt: '2026-03-01T00:00:00.000Z' });

    mockSend.mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(UpdateCommand);
      expect(command.input.ConditionExpression).toBe('attribute_exists(id)');
      return { Attributes: updated };
    });

    const res = await request(app).patch('/products/prod-1').send({ name: 'New name' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(updated);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('ignores client-sent id/createdAt/stock in the patch', async () => {
    let sentUpdate;
    mockSend.mockImplementation(async (command) => {
      sentUpdate = command;
      return { Attributes: makeProduct() };
    });

    await request(app)
      .patch('/products/prod-1')
      .send({ name: 'New name', id: 'attacker', createdAt: '1999-01-01', stock: 999 });

    const patchedFields = Object.values(sentUpdate.input.ExpressionAttributeNames || {});
    expect(patchedFields).toEqual(['name']);
  });

  it('returns 400 on an empty patch', async () => {
    const res = await request(app).patch('/products/prod-1').send({});

    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 400 on a patch with only non-patchable fields', async () => {
    const res = await request(app)
      .patch('/products/prod-1')
      .send({ id: 'attacker', createdAt: '1999-01-01', stock: 1 });

    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 400 on an invalid field value', async () => {
    const res = await request(app).patch('/products/prod-1').send({ price: -5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/price/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 404 when the product does not exist', async () => {
    mockSend.mockRejectedValueOnce(conditionFailure());

    const res = await request(app).patch('/products/missing').send({ name: 'New name' });

    expect(res.status).toBe(404);
  });

  it('returns 500 on a genuine DynamoDB failure', async () => {
    mockSend.mockRejectedValueOnce(new Error('network down'));

    const res = await request(app).patch('/products/prod-1').send({ name: 'New name' });

    expect(res.status).toBe(500);
  });
});

describe('PATCH /products/:id/stock', () => {
  it('applies a positive delta atomically and returns the new stock', async () => {
    mockSend.mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(UpdateCommand);
      expect(command.input.UpdateExpression).toBe('ADD stock :delta SET updatedAt = :updatedAt');
      expect(command.input.ConditionExpression).toBe(
        'attribute_exists(id) AND stock >= :minRequired'
      );
      expect(command.input.ExpressionAttributeValues[':delta']).toBe(3);
      expect(command.input.ExpressionAttributeValues[':minRequired']).toBe(-3);
      return { Attributes: { stock: 8 } };
    });

    const res = await request(app).patch('/products/prod-1/stock').send({ delta: 3 });

    expect(res.status).toBe(200);
    expect(res.body.stock).toBe(8);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('applies a negative delta with the correct minRequired', async () => {
    mockSend.mockImplementation(async (command) => {
      expect(command.input.ExpressionAttributeValues[':delta']).toBe(-2);
      expect(command.input.ExpressionAttributeValues[':minRequired']).toBe(2);
      return { Attributes: { stock: 3 } };
    });

    const res = await request(app).patch('/products/prod-1/stock').send({ delta: -2 });

    expect(res.status).toBe(200);
    expect(res.body.stock).toBe(3);
  });

  it('returns 400 when delta is missing', async () => {
    const res = await request(app).patch('/products/prod-1/stock').send({});

    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 400 when delta is not an integer', async () => {
    const res = await request(app).patch('/products/prod-1/stock').send({ delta: 1.5 });

    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 404 when the product does not exist (condition fails, then Get finds nothing)', async () => {
    mockSend.mockImplementation(async (command) => {
      if (command instanceof UpdateCommand) throw conditionFailure();
      if (command instanceof GetCommand) return {};
      throw new Error(`unexpected command ${command.constructor.name}`);
    });

    const res = await request(app).patch('/products/missing/stock').send({ delta: -1 });

    expect(res.status).toBe(404);
  });

  it('returns 409 when the delta would oversell (condition fails, then Get finds the product)', async () => {
    mockSend.mockImplementation(async (command) => {
      if (command instanceof UpdateCommand) throw conditionFailure();
      if (command instanceof GetCommand) return { Item: makeProduct({ stock: 0 }) };
      throw new Error(`unexpected command ${command.constructor.name}`);
    });

    const res = await request(app).patch('/products/prod-1/stock').send({ delta: -1 });

    expect(res.status).toBe(409);
  });

  it('still returns 500 on a genuine DynamoDB failure, not 404/409', async () => {
    mockSend.mockRejectedValueOnce(new Error('network down'));

    const res = await request(app).patch('/products/prod-1/stock').send({ delta: -1 });

    expect(res.status).toBe(500);
  });
});

describe('DELETE /products/:id', () => {
  it('deletes and returns 204', async () => {
    mockSend.mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(DeleteCommand);
      expect(command.input.ConditionExpression).toBe('attribute_exists(id)');
      return {};
    });

    const res = await request(app).delete('/products/prod-1');

    expect(res.status).toBe(204);
  });

  it('returns 404 when unknown', async () => {
    mockSend.mockRejectedValueOnce(conditionFailure());

    const res = await request(app).delete('/products/missing');

    expect(res.status).toBe(404);
  });

  it('returns 500 on a genuine DynamoDB failure', async () => {
    mockSend.mockRejectedValueOnce(new Error('network down'));

    const res = await request(app).delete('/products/prod-1');

    expect(res.status).toBe(500);
  });
});

describe('CORS', () => {
  it('answers OPTIONS preflight with 204', async () => {
    const res = await request(app).options('/products');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('DELETE');
  });

  it('defaults Access-Control-Allow-Origin to * when unset', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });

    const res = await request(app).get('/products');

    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});
