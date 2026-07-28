const express = require('express');
const request = require('supertest');

// Mock the JWKS verifier so `npm test` never needs network access or a real
// Cognito pool (CI has neither). The mocked create() always returns an
// object wrapping the same `verify` jest.fn, so tests can control its
// resolved/rejected behaviour per case.
jest.mock('aws-jwt-verify', () => {
  const verify = jest.fn();
  return {
    CognitoJwtVerifier: {
      create: jest.fn(() => ({ verify })),
    },
  };
});

describe('requireAuth — verifier configured', () => {
  let app;
  let verifyMock;

  beforeAll(() => {
    process.env.COGNITO_USER_POOL_ID = 'pool-123';
    process.env.COGNITO_CLIENT_ID = 'client-123';

    // eslint-disable-next-line global-require
    const { CognitoJwtVerifier } = require('aws-jwt-verify');
    verifyMock = CognitoJwtVerifier.create().verify;

    // eslint-disable-next-line global-require
    const { requireAuth } = require('../src/auth');
    app = express();
    app.get('/protected', requireAuth, (req, res) => res.status(200).json({ user: req.user }));
  });

  beforeEach(() => {
    verifyMock.mockReset();
  });

  it('returns 401 when no Authorization header is present', async () => {
    const res = await request(app).get('/protected');

    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('returns 401 when the Authorization header is not a Bearer token', async () => {
    const res = await request(app).get('/protected').set('Authorization', 'Basic abc123');

    expect(res.status).toBe(401);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('returns 401 when verification rejects (invalid, expired, or wrong audience)', async () => {
    verifyMock.mockRejectedValueOnce(new Error('Token expired'));

    const res = await request(app).get('/protected').set('Authorization', 'Bearer bad-token');

    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  it('attaches req.user = { sub, email } and proceeds when verification resolves', async () => {
    verifyMock.mockResolvedValueOnce({ sub: 'sub-1', email: 'jane@example.com', extra: 'ignored' });

    const res = await request(app).get('/protected').set('Authorization', 'Bearer good-token');

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ sub: 'sub-1', email: 'jane@example.com' });
    expect(verifyMock).toHaveBeenCalledWith('good-token');
  });
});

describe('requireAuth — auth not configured', () => {
  it('responds 401 "auth not configured" rather than crashing when env is unset', async () => {
    jest.resetModules();
    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_CLIENT_ID;

    // eslint-disable-next-line global-require
    const { requireAuth } = require('../src/auth');
    const app = express();
    app.get('/protected', requireAuth, (req, res) => res.status(200).json({}));

    const res = await request(app).get('/protected').set('Authorization', 'Bearer some-token');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it('does not throw merely from requiring the module with no env set', () => {
    jest.resetModules();
    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_CLIENT_ID;

    // eslint-disable-next-line global-require
    expect(() => require('../src/auth')).not.toThrow();
  });
});
