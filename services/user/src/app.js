const express = require('express');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const { requireAuth } = require('./auth');
const {
  validateProfileUpdateInput,
  pickProfileUpdate,
  buildProfileFromClaims,
  validateBillingInput,
  buildBillingRecord,
  containsForbiddenCardData,
} = require('./users');

// Table name is read from the environment — never hardcoded. In app-edge
// this is injected as USER_TABLE (the seam described in the service
// contract); locally it comes from docker-compose.
const TABLE_NAME = process.env.USER_TABLE;

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
// lazy-create below uses one to make the first-upsert race-safe.
const CONDITION_FAILED = 'ConditionalCheckFailedException';

function isConditionFailure(err) {
  return err && (err.name === CONDITION_FAILED || err.__type === CONDITION_FAILED);
}

/**
 * Returns the caller's profile row, lazily creating it from the verified
 * token's claims on first call. The conditional Put makes this race-safe:
 * if two requests race to create the same row, the loser's Put fails the
 * ConditionExpression and it simply re-reads the winner's row instead of
 * overwriting it.
 */
async function getOrCreateProfile(user) {
  const existing = await docClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId: user.sub } })
  );
  if (existing.Item) {
    return existing.Item;
  }

  const profile = buildProfileFromClaims(user);
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: profile,
        ConditionExpression: 'attribute_not_exists(userId)',
      })
    );
    return profile;
  } catch (err) {
    if (isConditionFailure(err)) {
      const reread = await docClient.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { userId: user.sub } })
      );
      return reread.Item;
    }
    throw err;
  }
}

const app = express();
app.use(express.json());

// CORS for the S3-hosted SPA, which calls this service cross-origin (the
// ALB is a different origin than the S3 website). Origin is read from env —
// never hardcode an origin, IP, or load-balancer DNS name here.
//
// The SPA sends an `Authorization: Bearer <id token>` header on every
// protected call, which makes every such call a *preflighted* cross-origin
// request — so Access-Control-Allow-Headers MUST include `authorization`,
// not just `content-type`, or the browser blocks the response before it
// ever reaches this service.
app.use((req, res, next) => {
  const allowedOrigin = process.env.CORS_ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  return next();
});

// ALB health check target. Must stay fast and DB-free so it always returns
// 200 as long as the process is up, independent of DynamoDB availability.
// No auth either — the ALB target group has no Cognito token to send.
app.get('/health', (req, res) => {
  res.status(200).type('text/plain').send('OK');
});

// GET /users/me — the caller's own profile, resolved only from the verified
// token (there is no /users/:id, so one user can never address another's
// record). Lazily creates the row on first call.
app.get('/users/me', requireAuth, async (req, res) => {
  try {
    const profile = await getOrCreateProfile(req.user);
    res.status(200).json(profile);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read profile' });
  }
});

// PUT /users/me — updates displayName/phone only. Any other field in the
// body (including an attempted userId/email override) is silently ignored:
// those values are never read from the request, only from the token.
app.put('/users/me', requireAuth, async (req, res) => {
  const validationError = validateProfileUpdateInput(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    // Lazy-create semantics apply here too: a PUT before any GET must still
    // succeed against a row that doesn't exist yet.
    await getOrCreateProfile(req.user);

    const fields = pickProfileUpdate(req.body || {});
    const updatedAt = new Date().toISOString();

    const setClauses = ['updatedAt = :updatedAt'];
    const values = { ':updatedAt': updatedAt };

    if (Object.prototype.hasOwnProperty.call(fields, 'displayName')) {
      setClauses.push('displayName = :displayName');
      values[':displayName'] = fields.displayName;
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'phone')) {
      setClauses.push('phone = :phone');
      values[':phone'] = fields.phone;
    }

    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { userId: req.user.sub },
        UpdateExpression: `SET ${setClauses.join(', ')}`,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      })
    );

    res.status(200).json(result.Attributes);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// GET /users/me/billing — 404 if billing was never set.
app.get('/users/me/billing', requireAuth, async (req, res) => {
  try {
    const result = await docClient.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { userId: req.user.sub } })
    );

    if (!result.Item || !result.Item.billing) {
      return res.status(404).json({ error: 'Billing information not set' });
    }

    res.status(200).json(result.Item.billing);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read billing information' });
  }
});

// PUT /users/me/billing — the PAN/CVV guard (PRD §3.3) runs FIRST, before
// any shape validation, any write, and any logging. Request bodies on this
// route are never logged, on success or failure.
app.put('/users/me/billing', requireAuth, async (req, res) => {
  if (containsForbiddenCardData(req.body)) {
    return res.status(400).json({
      error: 'Request contains raw card data (a PAN or CVV), which this service never accepts or stores',
    });
  }

  const validationError = validateBillingInput(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    await getOrCreateProfile(req.user);

    const billing = buildBillingRecord(req.body);
    const updatedAt = new Date().toISOString();

    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { userId: req.user.sub },
        UpdateExpression: 'SET billing = :billing, updatedAt = :updatedAt',
        ExpressionAttributeValues: { ':billing': billing, ':updatedAt': updatedAt },
        ReturnValues: 'ALL_NEW',
      })
    );

    res.status(200).json(result.Attributes.billing);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update billing information' });
  }
});

// DELETE /users/me/billing — idempotent: 204 whether or not billing (or
// even the profile row) exists. Never creates a row as a side effect of a
// delete, and never removes anything when there is nothing to remove.
app.delete('/users/me/billing', requireAuth, async (req, res) => {
  try {
    const existing = await docClient.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { userId: req.user.sub } })
    );

    if (!existing.Item || !existing.Item.billing) {
      return res.status(204).end();
    }

    const updatedAt = new Date().toISOString();
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { userId: req.user.sub },
        UpdateExpression: 'REMOVE billing SET updatedAt = :updatedAt',
        ExpressionAttributeValues: { ':updatedAt': updatedAt },
      })
    );

    return res.status(204).end();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete billing information' });
  }
});

module.exports = app;
