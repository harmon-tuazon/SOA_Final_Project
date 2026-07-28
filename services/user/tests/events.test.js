const request = require('supertest');

// Mock the DynamoDB document client with the same tiny in-memory table
// pattern as tests/routes.test.js, so the lazy-create path is exercised for
// real. "mock" prefix required so Jest allows referencing it inside
// jest.mock(), which is hoisted above this file's top-level code.
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: () => ({ send: mockDdbSend }),
    },
  };
});

// Mock the SQS client so this suite never needs real AWS credentials/network
// and can assert exactly what gets published (PRD platform/0008 §4.2).
const mockSqsSend = jest.fn();

jest.mock('@aws-sdk/client-sqs', () => {
  const actual = jest.requireActual('@aws-sdk/client-sqs');
  return {
    ...actual,
    SQSClient: jest.fn().mockImplementation(() => ({ send: mockSqsSend })),
  };
});

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
// The producer seam under test: set so events.js actually publishes.
process.env.NOTIFICATIONS_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/soa-notifications';

const { GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { SendMessageCommand } = require('@aws-sdk/client-sqs');
const { CognitoJwtVerifier } = require('aws-jwt-verify');

// eslint-disable-next-line global-require
const app = require('../src/app');

const verifyMock = CognitoJwtVerifier.create().verify;

let store;

function handleDdbCommand(command) {
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

  throw new Error(`unexpected command ${command.constructor.name}`);
}

const CURRENT_USER = { sub: 'user-1', email: 'jane@example.com' };

function asUser(req, claims = CURRENT_USER) {
  verifyMock.mockResolvedValueOnce(claims);
  return req.set('Authorization', 'Bearer test-token');
}

beforeEach(() => {
  store = new Map();
  mockDdbSend.mockReset();
  mockSqsSend.mockReset();
  verifyMock.mockReset();
  mockDdbSend.mockImplementation(async (command) => handleDdbCommand(command));
  mockSqsSend.mockResolvedValue({});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('UserProfileCreated publish on first GET /users/me', () => {
  it('publishes exactly once on the create and not again on a second GET', async () => {
    const first = await asUser(request(app).get('/users/me'));
    expect(first.status).toBe(200);

    // The publish is fire-and-forget (not awaited by the response) — flush
    // the microtask queue before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockSqsSend).toHaveBeenCalledTimes(1);

    const second = await asUser(request(app).get('/users/me'));
    expect(second.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
  });

  it('sends a body matching the PRD §3.1 UserProfileCreated shape', async () => {
    await asUser(request(app).get('/users/me'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    const [command] = mockSqsSend.mock.calls[0];
    expect(command).toBeInstanceOf(SendMessageCommand);
    expect(command.input.QueueUrl).toBe(process.env.NOTIFICATIONS_QUEUE_URL);

    const body = JSON.parse(command.input.MessageBody);
    expect(body.type).toBe('UserProfileCreated');
    expect(body.userId).toBe('user-1');
    expect(body.email).toBe('jane@example.com');
    expect(body.occurredAt).toEqual(expect.any(String));
    expect(() => new Date(body.occurredAt).toISOString()).not.toThrow();
  });

  it('does not change the HTTP response when the SQS publish rejects', async () => {
    mockSqsSend.mockRejectedValueOnce(new Error('Queue unavailable'));

    const res = await asUser(request(app).get('/users/me'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('user-1');
    expect(res.body.email).toBe('jane@example.com');
  });
});
