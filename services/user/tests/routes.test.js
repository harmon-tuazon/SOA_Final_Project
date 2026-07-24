const request = require('supertest');

// Mock the DynamoDB document client so `npm test` never needs a live
// DynamoDB Local / AWS credentials (CI has neither) — same pattern as
// services/order/tests/routes.test.js. Variable names must be prefixed with
// "mock" so Jest allows referencing them inside the jest.mock() factory
// (which is hoisted above this file's top-level code).
//
// Unlike order's fully-stubbed mockSend, this suite backs `send` with a
// tiny in-memory table so the lazy-create / conditional-put / update /
// remove semantics in src/app.js are actually exercised end to end —
// including proving the PAN guard writes nothing.
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

// Mock Cognito verification so tests need no network / real pool. The
// caller controls the resolved claims via verifyMock.
jest.mock('aws-jwt-verify', () => {
  const verify = jest.fn();
  return {
    CognitoJwtVerifier: {
      create: jest.fn(() => ({ verify })),
    },
  };
});

process.env.COGNITO_USER_POOL_ID = 'pool-123';
process.env.COGNITO_CLIENT_ID = 'client-123';
process.env.USER_TABLE = 'soa-user-test';

const {
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const { CognitoJwtVerifier } = require('aws-jwt-verify');

// eslint-disable-next-line global-require
const app = require('../src/app');

const verifyMock = CognitoJwtVerifier.create().verify;

let store;

/** Minimal in-memory DynamoDB stand-in covering the operations app.js uses. */
function handleCommand(command) {
  if (command instanceof GetCommand) {
    const item = store.get(command.input.Key.userId);
    return item ? { Item: { ...item } } : {};
  }

  if (command instanceof PutCommand) {
    const key = command.input.Item.userId;
    if (command.input.ConditionExpression === 'attribute_not_exists(userId)' && store.has(key)) {
      const err = new Error('The conditional request failed');
      err.name = 'ConditionalCheckFailedException';
      throw err;
    }
    store.set(key, { ...command.input.Item });
    return {};
  }

  if (command instanceof UpdateCommand) {
    const key = command.input.Key.userId;
    const existing = store.get(key) || { userId: key };
    const updated = { ...existing };
    const values = command.input.ExpressionAttributeValues || {};
    const expr = command.input.UpdateExpression;

    if (expr.startsWith('REMOVE')) {
      delete updated.billing;
      const setMatch = /SET\s+(.+)$/.exec(expr);
      if (setMatch) {
        applySetClauses(setMatch[1], values, updated);
      }
    } else if (expr.startsWith('SET')) {
      applySetClauses(expr.replace(/^SET\s*/, ''), values, updated);
    }

    store.set(key, updated);
    return { Attributes: { ...updated } };
  }

  if (command instanceof ScanCommand) {
    return { Items: Array.from(store.values()).map((item) => ({ ...item })) };
  }

  throw new Error(`unexpected command ${command.constructor.name}`);
}

function applySetClauses(setPart, values, target) {
  setPart.split(',').forEach((clause) => {
    const [attr, token] = clause.split('=').map((s) => s.trim());
    // eslint-disable-next-line no-param-reassign
    target[attr] = values[token];
  });
}

const CURRENT_USER = { sub: 'user-1', email: 'jane@example.com' };

function asUser(req, claims = CURRENT_USER) {
  verifyMock.mockResolvedValueOnce(claims);
  return req.set('Authorization', 'Bearer test-token');
}

function validBilling(overrides = {}) {
  const currentYear = new Date().getFullYear();
  return {
    cardholderName: 'Jane Doe',
    cardBrand: 'VISA',
    cardLast4: '1234',
    cardExpMonth: 6,
    cardExpYear: currentYear + 1,
    paymentMethodToken: 'tok_abc123',
    billingAddress: {
      line1: '123 Main St',
      city: 'Toronto',
      postalCode: 'M5V 2T6',
      country: 'CA',
    },
    ...overrides,
  };
}

beforeEach(() => {
  store = new Map();
  mockSend.mockReset();
  verifyMock.mockReset();
  mockSend.mockImplementation(async (command) => handleCommand(command));
});

describe('GET /users/me', () => {
  it('returns 401 with no Authorization header', async () => {
    const res = await request(app).get('/users/me');
    expect(res.status).toBe(401);
  });

  it('lazily creates the profile from token claims on first call', async () => {
    const res = await asUser(request(app).get('/users/me'));

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('user-1');
    expect(res.body.email).toBe('jane@example.com');
    expect(res.body.displayName).toBe('');
    expect(res.body.createdAt).toEqual(expect.any(String));
    expect(res.body.updatedAt).toBe(res.body.createdAt);
    expect(store.has('user-1')).toBe(true);
  });

  it('returns the same row (not recreated) on a second call', async () => {
    const first = await asUser(request(app).get('/users/me'));
    const second = await asUser(request(app).get('/users/me'));

    expect(second.status).toBe(200);
    expect(second.body.createdAt).toBe(first.body.createdAt);
  });
});

describe('PUT /users/me', () => {
  it('updates displayName/phone and ignores userId/email/createdAt in the body', async () => {
    const res = await asUser(
      request(app).put('/users/me').send({
        displayName: 'Jane',
        phone: '555-0100',
        userId: 'attacker-sub',
        email: 'attacker@example.com',
        createdAt: '1999-01-01T00:00:00.000Z',
      })
    );

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('user-1');
    expect(res.body.email).toBe('jane@example.com');
    expect(res.body.displayName).toBe('Jane');
    expect(res.body.phone).toBe('555-0100');
  });

  it('lazily creates the row first if it does not exist yet', async () => {
    expect(store.size).toBe(0);

    const res = await asUser(request(app).put('/users/me').send({ displayName: 'Jane' }));

    expect(res.status).toBe(200);
    expect(store.has('user-1')).toBe(true);
  });

  it('returns 400 on an invalid displayName and writes nothing', async () => {
    const res = await asUser(
      request(app).put('/users/me').send({ displayName: 'x'.repeat(101) })
    );

    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 400 on an invalid phone', async () => {
    const res = await asUser(
      request(app).put('/users/me').send({ phone: '1'.repeat(31) })
    );

    expect(res.status).toBe(400);
  });
});

describe('billing round trip', () => {
  it('returns 404 when billing was never set', async () => {
    const res = await asUser(request(app).get('/users/me/billing'));
    expect(res.status).toBe(404);
  });

  it('sets billing via PUT and reads it back via GET', async () => {
    const putRes = await asUser(request(app).put('/users/me/billing').send(validBilling()));

    expect(putRes.status).toBe(200);
    expect(putRes.body).toEqual(validBilling());

    const getRes = await asUser(request(app).get('/users/me/billing'));
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual(validBilling());
  });

  it('returns 400 on an invalid billing shape and writes nothing', async () => {
    const res = await asUser(
      request(app).put('/users/me/billing').send(validBilling({ cardBrand: 'DINERS' }))
    );

    expect(res.status).toBe(400);
    expect(store.has('user-1')).toBe(false);
  });

  it('DELETE removes billing (204), then GET returns 404', async () => {
    await asUser(request(app).put('/users/me/billing').send(validBilling()));

    const delRes = await asUser(request(app).delete('/users/me/billing'));
    expect(delRes.status).toBe(204);

    const getRes = await asUser(request(app).get('/users/me/billing'));
    expect(getRes.status).toBe(404);
  });

  it('DELETE is idempotent — 204 even when billing was never set', async () => {
    const res = await asUser(request(app).delete('/users/me/billing'));
    expect(res.status).toBe(204);
  });

  it('DELETE is idempotent — a second DELETE also returns 204', async () => {
    await asUser(request(app).put('/users/me/billing').send(validBilling()));
    await asUser(request(app).delete('/users/me/billing'));

    const res = await asUser(request(app).delete('/users/me/billing'));
    expect(res.status).toBe(204);
  });
});

describe('PAN/CVV guard on PUT /users/me/billing', () => {
  it.each(['cardNumber', 'number', 'pan', 'cvv', 'cvc', 'securityCode'])(
    'rejects a body carrying a %s key and writes nothing',
    async (key) => {
      const res = await asUser(
        request(app)
          .put('/users/me/billing')
          .send({ ...validBilling(), [key]: '4111111111111111' })
      );

      expect(res.status).toBe(400);
      expect(mockSend).not.toHaveBeenCalled();

      // Verify nothing was persisted: a fresh read must still be 404.
      const getRes = await asUser(request(app).get('/users/me/billing'));
      expect(getRes.status).toBe(404);
    }
  );

  it.each(['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111'])(
    'rejects a body carrying the raw PAN shape %s in any field and writes nothing',
    async (pan) => {
      const res = await asUser(
        request(app)
          .put('/users/me/billing')
          .send({ ...validBilling(), cardholderName: pan })
      );

      expect(res.status).toBe(400);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it('does not trip on a legitimate billing body (cardLast4, paymentMethodToken)', async () => {
    const res = await asUser(request(app).put('/users/me/billing').send(validBilling()));
    expect(res.status).toBe(200);
  });
});

describe('CORS', () => {
  it('answers OPTIONS preflight with 204 and no auth required', async () => {
    const res = await request(app).options('/users/me');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('PUT');
    expect(res.headers['access-control-allow-methods']).toContain('DELETE');
  });

  it('advertises authorization in Access-Control-Allow-Headers', async () => {
    const res = await request(app).options('/users/me');

    expect(res.headers['access-control-allow-headers']).toMatch(/authorization/i);
    expect(res.headers['access-control-allow-headers']).toMatch(/content-type/i);
  });

  it('defaults Access-Control-Allow-Origin to * when unset', async () => {
    const res = await asUser(request(app).get('/users/me'));
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});
