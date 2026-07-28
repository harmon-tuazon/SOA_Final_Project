'use strict';

// notification-worker — SQS-triggered Lambda that formats a welcome
// notification and fans it out via SNS (PRD platform/0008 §3.1-3.2).
//
// Runtime note: the nodejs20.x Lambda runtime bundles the AWS SDK v3, so
// @aws-sdk/client-sns is listed as a devDependency only (used for local
// tests) and is NOT bundled into the deploy artifact — the deploy zip is
// just this file (see package.json / cd.yml packaging step). Do not move
// @aws-sdk/client-sns to "dependencies".

const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

// Lazy-created, module-level singleton — same style as services/*/src/app.js
// use for their DynamoDB clients. Reused across warm invocations.
const snsClient = new SNSClient({});

const TOPIC_ARN = process.env.TOPIC_ARN;

const KNOWN_EVENT_TYPES = new Set(['UserProfileCreated']);

/**
 * Builds the welcome notification's subject/message for a UserProfileCreated
 * event (PRD §3.1: type, userId, email, displayName?, occurredAt).
 */
function formatUserProfileCreated(event) {
  const greetingName = event.displayName || event.email;
  return {
    subject: 'Welcome to the SOA store',
    message: `Hi ${greetingName}, welcome to the SOA store! Your account (${event.email}) is ready to go.`,
  };
}

/**
 * Formats a notification for a known event type. Returns null for an
 * unrecognised `type` so the caller can skip it (forward-compatible: new
 * event types can be added by producers before the worker knows about them).
 */
function formatNotification(event) {
  if (event.type === 'UserProfileCreated') {
    return formatUserProfileCreated(event);
  }
  return null;
}

/**
 * SQS batch handler. Uses the partial-batch-failure convention
 * (`batchItemFailures`) so a single bad record never fails — or infinitely
 * retries — the whole batch:
 *
 *  - A malformed (non-JSON) body is warned and skipped: it is never retried
 *    and never reported as a failure, because retrying it would only loop a
 *    poison message forever (redrive to the DLQ is handled by the queue's
 *    own maxReceiveCount, not by re-failing an unparseable record here).
 *  - An unknown `type` is warned and skipped (forward-compatible).
 *  - A valid, known event that fails to publish to SNS IS reported as a
 *    batch item failure, so SQS retries only that record.
 */
async function handler(event) {
  const batchItemFailures = [];

  const records = (event && event.Records) || [];

  for (const record of records) {
    let parsed;
    try {
      parsed = JSON.parse(record.body);
    } catch (err) {
      console.warn('Skipping malformed SQS message body (not valid JSON)', {
        messageId: record.messageId,
      });
      continue; // eslint-disable-line no-continue
    }

    const notification = formatNotification(parsed);
    if (!notification) {
      console.warn('Skipping SQS message with unknown or missing event type', {
        messageId: record.messageId,
        type: parsed && parsed.type,
      });
      continue; // eslint-disable-line no-continue
    }

    try {
      await snsClient.send(
        new PublishCommand({
          TopicArn: TOPIC_ARN,
          Subject: notification.subject,
          Message: notification.message,
        })
      );
    } catch (err) {
      console.error('Failed to publish notification to SNS; will retry', {
        messageId: record.messageId,
        error: err && err.message,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}

module.exports = { handler };
