const request = require('supertest');
const app = require('../src/app');

// These cases are rejected before the DynamoDB call is made, so they don't
// require a DynamoDB endpoint/credentials to run.
describe('POST /items validation', () => {
  it('rejects an empty body with 400', async () => {
    const res = await request(app).post('/items').send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('rejects a non-object (array) body with 400', async () => {
    const res = await request(app)
      .post('/items')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify([1, 2, 3]));

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});
