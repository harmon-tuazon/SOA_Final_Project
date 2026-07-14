const express = require('express');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
} = require('@aws-sdk/lib-dynamodb');

// PLACEHOLDER: __TABLE_ENV__ is the env var name holding this service's
// DynamoDB table name (e.g. ITEMS_TABLE). Replaced by /new-service.
const TABLE_NAME = process.env.__TABLE_ENV__;

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

const app = express();
app.use(express.json());

// ALB health check target. Must stay fast and DB-free so it always returns
// 200 as long as the process is up, independent of DynamoDB availability.
app.get('/health', (req, res) => {
  res.status(200).type('text/plain').send('OK');
});

// PLACEHOLDER: __RESOURCE__ is the REST resource noun (e.g. items, orders).
// Replaced by /new-service, along with the route paths below.
app.get('/__RESOURCE__', async (req, res) => {
  try {
    const result = await docClient.send(
      new ScanCommand({ TableName: TABLE_NAME })
    );
    res.status(200).json(result.Items || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read __RESOURCE__' });
  }
});

app.post('/__RESOURCE__', async (req, res) => {
  const item = req.body;

  if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length === 0) {
    return res.status(400).json({ error: 'Request body must be a non-empty JSON object' });
  }

  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
      })
    );
    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ error: 'Failed to write __RESOURCE__' });
  }
});

module.exports = app;
