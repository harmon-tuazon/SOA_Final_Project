// Async event publishing for the user service — the first producer onto the
// notifications SQS queue (PRD platform/0008 §3, §3.1). Sync services never
// block on async work: this is fire-and-forget from the caller's point of
// view (see the .catch() at the app.js call site) and must never delay or
// change the HTTP response.

const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

// Queue URL is read from the environment — never hardcoded. In app-edge this
// is injected as NOTIFICATIONS_QUEUE_URL (the seam PRD platform/0008
// describes); it is unset in local dev and in any deploy that predates
// platform/0008, which must keep working unchanged (hence the no-op below).
const QUEUE_URL = process.env.NOTIFICATIONS_QUEUE_URL;

// Lazy-created, module-level singleton — same pattern as the DynamoDB client
// in src/app.js. Only constructed if a queue URL is actually configured, so
// requiring this module never fails for local dev / pre-0008 deploys.
let sqsClient;

function getSqsClient() {
  if (!sqsClient) {
    sqsClient = new SQSClient({});
  }
  return sqsClient;
}

/**
 * Publishes a UserProfileCreated event (PRD §3.1 shape) for the given
 * profile. No-ops (resolves to `false`) when NOTIFICATIONS_QUEUE_URL is
 * unset/empty, so local dev and any deploy that predates the messaging
 * factory behave exactly as before. Resolves to `true` on a successful
 * publish, and *rejects* on an SQS failure — callers must not await this in
 * a way that blocks the response; see the fire-and-forget call site in
 * app.js, which attaches a .catch() to log without affecting the response.
 */
async function publishUserProfileCreated(profile) {
  if (!QUEUE_URL) {
    return false;
  }

  const body = {
    type: 'UserProfileCreated',
    userId: profile.userId,
    email: profile.email,
    occurredAt: new Date().toISOString(),
  };
  if (profile.displayName) {
    body.displayName = profile.displayName;
  }

  await getSqsClient().send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(body),
    })
  );
  return true;
}

module.exports = { publishUserProfileCreated };
