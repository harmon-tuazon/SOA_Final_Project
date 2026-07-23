const express = require('express');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const {
  validateCreateOrderInput,
  isKnownStatus,
  canTransitionStatus,
  buildOrderFromInput,
} = require('./orders');

// Table name is read from the environment — never hardcoded. In app-edge
// this is injected as ORDER_TABLE (the seam described in the service
// contract); locally it comes from docker-compose.
const TABLE_NAME = process.env.ORDER_TABLE;

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

// DynamoDB raises this when a write's ConditionExpression doesn't hold. The
// status writes below use one to make read-then-write atomic, so this means
// "someone else changed the order first", which is the same 409 the
// pre-flight transition check returns.
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
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
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

// GET /orders — list, newest placedAt first. Optional ?customerId= filter.
// The shared `data` module provisions a hash-key-only table (no GSI), so
// filtering by customerId is a Scan + FilterExpression rather than a Query.
// Documented, deliberate limitation — see services/order/README.md.
app.get('/orders', async (req, res) => {
  try {
    const { customerId } = req.query;

    // Express parses a repeated query param (?customerId=a&customerId=b) into
    // an array, which would marshal into a DynamoDB List and fail at the
    // service — a 400 is the honest answer, not a 500.
    if (customerId !== undefined && typeof customerId !== 'string') {
      return res.status(400).json({
        error: 'customerId must be given at most once',
      });
    }

    const params = { TableName: TABLE_NAME };

    if (customerId) {
      params.FilterExpression = 'customerId = :customerId';
      params.ExpressionAttributeValues = { ':customerId': customerId };
    }

    const result = await docClient.send(new ScanCommand(params));
    const items = (result.Items || []).slice().sort((a, b) => {
      if (a.placedAt === b.placedAt) return 0;
      return a.placedAt < b.placedAt ? 1 : -1;
    });

    res.status(200).json(items);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read orders' });
  }
});

// GET /orders/:id — a single order, or 404.
app.get('/orders/:id', async (req, res) => {
  try {
    const result = await docClient.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { id: req.params.id } })
    );

    if (!result.Item) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.status(200).json(result.Item);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read order' });
  }
});

// POST /orders — create. Server derives id/total/status/placedAt/
// deliveryEstimate/updatedAt; any client-supplied values for those fields
// are ignored, never trusted (see buildOrderFromInput in ./orders).
app.post('/orders', async (req, res) => {
  const validationError = validateCreateOrderInput(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const order = buildOrderFromInput(req.body);

  try {
    await docClient.send(
      new PutCommand({ TableName: TABLE_NAME, Item: order })
    );
    res.status(201).json(order);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// PATCH /orders/:id/status — advance status. Only PLACED->SHIPPED and
// SHIPPED->DELIVERED are legal; everything else (including transitions out
// of CANCELLED/DELIVERED) is 409.
app.patch('/orders/:id/status', async (req, res) => {
  const status = req.body && req.body.status;

  if (!status || !isKnownStatus(status)) {
    return res.status(400).json({
      error: 'status is required and must be one of PLACED, SHIPPED, DELIVERED, CANCELLED',
    });
  }

  try {
    const existing = await docClient.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { id: req.params.id } })
    );

    if (!existing.Item) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = existing.Item;

    if (!canTransitionStatus(order.status, status)) {
      return res.status(409).json({
        error: `Cannot transition order from ${order.status} to ${status}`,
      });
    }

    const updatedAt = new Date().toISOString();

    // Condition on the status we just read, so a concurrent transition or
    // cancel can't be silently overwritten between the Get and the Update.
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { id: req.params.id },
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
        ConditionExpression: '#status = :expectedStatus',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': status,
          ':updatedAt': updatedAt,
          ':expectedStatus': order.status,
        },
      })
    );

    res.status(200).json({ ...order, status, updatedAt });
  } catch (err) {
    if (isConditionFailure(err)) {
      return res.status(409).json({
        error: 'Order status changed concurrently; retry with the current status',
      });
    }
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// POST /orders/:id/cancel — allowed only from PLACED.
app.post('/orders/:id/cancel', async (req, res) => {
  try {
    const existing = await docClient.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { id: req.params.id } })
    );

    if (!existing.Item) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = existing.Item;

    if (order.status !== 'PLACED') {
      return res.status(409).json({
        error: `Cannot cancel order in status ${order.status}`,
      });
    }

    const updatedAt = new Date().toISOString();

    // Same atomicity guard as the status route: only cancel if the order is
    // still PLACED at write time, not merely at read time.
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { id: req.params.id },
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
        ConditionExpression: '#status = :expectedStatus',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'CANCELLED',
          ':updatedAt': updatedAt,
          ':expectedStatus': 'PLACED',
        },
      })
    );

    res.status(200).json({ ...order, status: 'CANCELLED', updatedAt });
  } catch (err) {
    if (isConditionFailure(err)) {
      return res.status(409).json({
        error: 'Order status changed concurrently; it is no longer cancellable',
      });
    }
    res.status(500).json({ error: 'Failed to cancel order' });
  }
});

module.exports = app;
