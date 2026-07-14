const request = require('supertest');
const app = require('../src/app');

describe('GET /health', () => {
  it('returns 200 OK without touching AWS/DynamoDB', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');
  });
});
