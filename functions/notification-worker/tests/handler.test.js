// Mock the SNS client so `npm test` never needs real AWS credentials/network
// (mirrors the DynamoDB-mocking pattern in services/*/tests). The "mock"
// prefix is required so Jest allows referencing it inside jest.mock(), which
// is hoisted above this file's top-level code.
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-sns', () => {
  const actual = jest.requireActual('@aws-sdk/client-sns');
  return {
    ...actual,
    SNSClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  };
});

process.env.TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:soa-notifications';

const { PublishCommand } = require('@aws-sdk/client-sns');
// eslint-disable-next-line global-require
const { handler } = require('../index');

function sqsRecord(body, messageId) {
  return { messageId, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

const VALID_EVENT = {
  type: 'UserProfileCreated',
  userId: 'user-1',
  email: 'jane@example.com',
  displayName: 'Jane',
  occurredAt: '2026-07-24T00:00:00.000Z',
};

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('notification-worker handler', () => {
  it('publishes a welcome notification for a valid UserProfileCreated event', async () => {
    const result = await handler({ Records: [sqsRecord(VALID_EVENT, 'msg-1')] });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [command] = mockSend.mock.calls[0];
    expect(command).toBeInstanceOf(PublishCommand);
    expect(command.input.TopicArn).toBe(process.env.TOPIC_ARN);
    expect(command.input.Subject).toEqual(expect.stringContaining('Welcome'));
    expect(command.input.Message).toEqual(expect.stringContaining('Jane'));
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('skips a malformed (non-JSON) record without throwing and without publishing', async () => {
    const result = await handler({ Records: [sqsRecord('{not json', 'msg-bad')] });

    expect(mockSend).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('processes a mixed batch: publishes only the valid record, no failures reported', async () => {
    const result = await handler({
      Records: [sqsRecord(VALID_EVENT, 'msg-1'), sqsRecord('{not json', 'msg-bad')],
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('reports only the failed record as a batch item failure when SNS publish rejects', async () => {
    mockSend
      .mockRejectedValueOnce(new Error('Throttled'))
      .mockResolvedValueOnce({});

    const result = await handler({
      Records: [
        sqsRecord(VALID_EVENT, 'msg-fail'),
        sqsRecord({ ...VALID_EVENT, userId: 'user-2' }, 'msg-ok'),
      ],
    });

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-fail' }] });
  });

  it('skips a record with an unknown event type without publishing', async () => {
    const result = await handler({
      Records: [sqsRecord({ type: 'SomethingElse', foo: 'bar' }, 'msg-unknown')],
    });

    expect(mockSend).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('falls back to email in the greeting when displayName is absent', async () => {
    const { displayName, ...withoutDisplayName } = VALID_EVENT;
    await handler({ Records: [sqsRecord(withoutDisplayName, 'msg-no-name')] });

    const [command] = mockSend.mock.calls[0];
    expect(command.input.Message).toEqual(expect.stringContaining(withoutDisplayName.email));
  });
});
