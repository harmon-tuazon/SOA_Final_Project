const express = require('express');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} = require('@aws-sdk/lib-dynamodb');

const {
  isValidStockDelta,
  validateCreateProductInput,
  validatePatchProductInput,
  buildProductFromInput,
  buildProductPatch,
} = require('./products');

// Table name is read from the environment — never hardcoded. In app-edge
// this is injected as PRODUCT_TABLE (the seam described in the service
// contract); locally it comes from docker-compose.
const TABLE_NAME = process.env.PRODUCT_TABLE;

// Local dev (docker-compose) points at DynamoDB Local via DYNAMODB_ENDPOINT.
// In AWS, no endpoint override is set, so the SDK talks to real DynamoDB
// and picks up credentials from the ECS task role — never hardcode either.
const clientConfig = process.env.DYNAMODB_ENDPOINT
  ? {
      endpoint: process.env.DYNAMODB_ENDPOINT,
      region: process.env.AWS_REGION || 'us-east-1',
    }
  : {};

const ddbClient = new DynamoDBClient(clientConfig);
const docClient = DynamoDBDocumentClient.from(ddbClient);

// DynamoDB raises this when a write's ConditionExpression doesn't hold. All
// writes below use one (existence checks, stock floor), so this always
// means "the condition wasn't met at write time" — mapped to 404/409 by
// each route below, never surfaced as a 500.
const CONDITION_FAILED = 'ConditionalCheckFailedException';

function isConditionFailure(err) {
  return err && (err.name === CONDITION_FAILED || err.__type === CONDITION_FAILED);
}

const app = express();
app.use(express.json());

// CORS for the S3-hosted SPA, which calls this service cross-origin (the
// ALB is a different origin than the S3 website). Origin is read from env —
// never hardcode an origin, IP, or load-balancer DNS name here.
// Hand-rolled rather than the `cors` package to keep the image lean.
app.use((req, res, next) => {
  const allowedOrigin = process.env.CORS_ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  return next();
});

// ALB health check target. Must stay fast and DB-free so it always returns
// 200 as long as the process is up, independent of DynamoDB availability.
app.get('/health', (req, res) => {
  res.status(200).type('text/plain').send('OK');
});

// GET /products — list, newest createdAt first. Optional ?category= (exact
// match) and ?q= (case-insensitive substring on name + description),
// combinable. The shared `data` module provisions a hash-key-only table (no
// GSI), so this is a Scan rather than a Query. `category` is pushed down as
// a FilterExpression (DynamoDB can evaluate an exact match server-side); `q`
// needs case-insensitive substring matching, which DynamoDB's FilterExpression
// cannot express, so it is applied in-app after the Scan returns.
app.get('/products', async (req, res) => {
  try {
    const { category, q } = req.query;

    // Express parses a repeated query param (?category=a&category=b) into
    // an array, which would marshal into a DynamoDB List and fail at the
    // service — a 400 is the honest answer, not a 500. Checked before any
    // DynamoDB call.
    if (category !== undefined && typeof category !== 'string') {
      return res.status(400).json({ error: 'category must be given at most once' });
    }
    if (q !== undefined && typeof q !== 'string') {
      return res.status(400).json({ error: 'q must be given at most once' });
    }

    const params = { TableName: TABLE_NAME };

    if (category) {
      params.FilterExpression = 'category = :category';
      params.ExpressionAttributeValues = { ':category': category };
    }

    const result = await docClient.send(new ScanCommand(params));
    let items = result.Items || [];

    if (q) {
      const needle = q.toLowerCase();
      items = items.filter((item) => {
        const name = (item.name || '').toLowerCase();
        const description = (item.description || '').toLowerCase();
        return name.includes(needle) || description.includes(needle);
      });
    }

    items = items.slice().sort((a, b) => {
      if (a.createdAt === b.createdAt) return 0;
      return a.createdAt < b.createdAt ? 1 : -1;
    });

    res.status(200).json(items);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read products' });
  }
});

// GET /products/:id — a single product, or 404.
app.get('/products/:id', async (req, res) => {
  try {
    const result = await docClient.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { id: req.params.id } })
    );

    if (!result.Item) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.status(200).json(result.Item);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read product' });
  }
});

// POST /products — create. Server derives id/createdAt/updatedAt (and
// defaults stock/rating); any client-supplied values for those fields are
// ignored, never trusted (see buildProductFromInput in ./products).
app.post('/products', async (req, res) => {
  const validationError = validateCreateProductInput(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const product = buildProductFromInput(req.body);

  try {
    await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: product }));
    res.status(201).json(product);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// PATCH /products/:id — partial update of name/description/price/category/
// imageUrl/rating only; id/createdAt/stock are never touched here. A single
// conditional UpdateCommand does the existence check and the write in one
// atomic call (no read-then-write), returning the updated item via
// ReturnValues: ALL_NEW so no follow-up Get is needed on the success path.
app.patch('/products/:id', async (req, res) => {
  const validationError = validatePatchProductInput(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const patch = buildProductPatch(req.body);
  const updatedAt = new Date().toISOString();

  const expressionAttributeNames = {};
  const expressionAttributeValues = { ':updatedAt': updatedAt };
  const setClauses = ['updatedAt = :updatedAt'];

  Object.keys(patch).forEach((field, index) => {
    const nameToken = `#f${index}`;
    const valueToken = `:v${index}`;
    expressionAttributeNames[nameToken] = field;
    expressionAttributeValues[valueToken] = patch[field];
    setClauses.push(`${nameToken} = ${valueToken}`);
  });

  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { id: req.params.id },
        UpdateExpression: `SET ${setClauses.join(', ')}`,
        ConditionExpression: 'attribute_exists(id)',
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW',
      })
    );

    res.status(200).json(result.Attributes);
  } catch (err) {
    if (isConditionFailure(err)) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// PATCH /products/:id/stock — adjust stock by {delta}. A single atomic
// conditional UpdateCommand (`ADD stock :delta`) guarded by a
// ConditionExpression that the *result* stays >= 0, rather than a
// read-then-write — two concurrent decrements cannot both succeed past
// zero. The one wrinkle: the same ConditionalCheckFailedException fires
// both when the product doesn't exist and when the delta would oversell,
// and the client needs 404 vs 409 to tell those apart. Rather than turning
// the write itself into a read-then-write (which would reopen the race this
// route exists to close), a follow-up GetCommand runs ONLY on the
// condition-failure path to decide which of the two applies.
app.patch('/products/:id/stock', async (req, res) => {
  const delta = req.body && req.body.delta;

  if (!isValidStockDelta(delta)) {
    return res.status(400).json({ error: 'delta is required and must be an integer' });
  }

  const updatedAt = new Date().toISOString();

  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { id: req.params.id },
        UpdateExpression: 'ADD stock :delta SET updatedAt = :updatedAt',
        ConditionExpression: 'attribute_exists(id) AND stock >= :minRequired',
        ExpressionAttributeValues: {
          ':delta': delta,
          // stock + delta >= 0  <=>  stock >= -delta
          ':minRequired': -delta,
          ':updatedAt': updatedAt,
        },
        ReturnValues: 'UPDATED_NEW',
      })
    );

    return res.status(200).json({ id: req.params.id, stock: result.Attributes.stock });
  } catch (err) {
    if (!isConditionFailure(err)) {
      return res.status(500).json({ error: 'Failed to adjust stock' });
    }

    // Condition failed — find out why, read-only, off the write's hot path.
    try {
      const existing = await docClient.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { id: req.params.id } })
      );

      if (!existing.Item) {
        return res.status(404).json({ error: 'Product not found' });
      }

      return res.status(409).json({ error: 'Insufficient stock for this adjustment' });
    } catch (lookupErr) {
      return res.status(500).json({ error: 'Failed to adjust stock' });
    }
  }
});

// DELETE /products/:id — remove. ConditionExpression: attribute_exists(id)
// so deleting an unknown id maps to 404 instead of a silent no-op 204.
app.delete('/products/:id', async (req, res) => {
  try {
    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { id: req.params.id },
        ConditionExpression: 'attribute_exists(id)',
      })
    );

    return res.status(204).send();
  } catch (err) {
    if (isConditionFailure(err)) {
      return res.status(404).json({ error: 'Product not found' });
    }
    return res.status(500).json({ error: 'Failed to delete product' });
  }
});

module.exports = app;
