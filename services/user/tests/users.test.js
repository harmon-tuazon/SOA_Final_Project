const {
  validateProfileUpdateInput,
  pickProfileUpdate,
  buildProfileFromClaims,
  validateBillingInput,
  buildBillingRecord,
  containsForbiddenCardData,
} = require('../src/users');

const currentYear = new Date().getFullYear();

function validBilling(overrides = {}) {
  return {
    cardholderName: 'Jane Doe',
    cardBrand: 'VISA',
    cardLast4: '1234',
    cardExpMonth: 6,
    cardExpYear: currentYear + 1,
    paymentMethodToken: 'tok_abc123',
    billingAddress: {
      line1: '123 Main St',
      city: 'Toronto',
      postalCode: 'M5V 2T6',
      country: 'CA',
    },
    ...overrides,
  };
}

describe('validateProfileUpdateInput', () => {
  it('accepts an empty body (no-op update)', () => {
    expect(validateProfileUpdateInput({})).toBeNull();
  });

  it('accepts a valid displayName', () => {
    expect(validateProfileUpdateInput({ displayName: 'Jane' })).toBeNull();
  });

  it('accepts a valid phone', () => {
    expect(validateProfileUpdateInput({ phone: '+1-555-0100' })).toBeNull();
  });

  it('rejects a non-object body', () => {
    expect(validateProfileUpdateInput('nope')).toMatch(/JSON object/);
  });

  it('rejects a missing body', () => {
    expect(validateProfileUpdateInput(undefined)).toMatch(/JSON object/);
  });

  it('rejects a displayName over 100 chars', () => {
    const body = { displayName: 'x'.repeat(101) };
    expect(validateProfileUpdateInput(body)).toMatch(/displayName/);
  });

  it('accepts a displayName of exactly 100 chars', () => {
    const body = { displayName: 'x'.repeat(100) };
    expect(validateProfileUpdateInput(body)).toBeNull();
  });

  it('rejects a non-string displayName', () => {
    expect(validateProfileUpdateInput({ displayName: 42 })).toMatch(/displayName/);
  });

  it('rejects a phone over 30 chars', () => {
    const body = { phone: '1'.repeat(31) };
    expect(validateProfileUpdateInput(body)).toMatch(/phone/);
  });

  it('accepts a phone of exactly 30 chars', () => {
    const body = { phone: '1'.repeat(30) };
    expect(validateProfileUpdateInput(body)).toBeNull();
  });

  it('rejects a non-string phone', () => {
    expect(validateProfileUpdateInput({ phone: 5551234 })).toMatch(/phone/);
  });
});

describe('pickProfileUpdate', () => {
  it('picks only displayName/phone, ignoring everything else', () => {
    const body = {
      displayName: 'Jane',
      phone: '555-0100',
      userId: 'attacker-sub',
      email: 'attacker@example.com',
      createdAt: '1999-01-01T00:00:00.000Z',
    };

    expect(pickProfileUpdate(body)).toEqual({
      displayName: 'Jane',
      phone: '555-0100',
    });
  });

  it('omits fields that were not present in the body', () => {
    expect(pickProfileUpdate({ displayName: 'Jane' })).toEqual({ displayName: 'Jane' });
    expect(pickProfileUpdate({})).toEqual({});
  });
});

describe('buildProfileFromClaims', () => {
  it('derives userId/email from claims and server-sets createdAt/updatedAt', () => {
    const profile = buildProfileFromClaims({ sub: 'sub-123', email: 'jane@example.com' });

    expect(profile.userId).toBe('sub-123');
    expect(profile.email).toBe('jane@example.com');
    expect(profile.displayName).toBe('');
    expect(profile.createdAt).toEqual(expect.any(String));
    expect(profile.updatedAt).toBe(profile.createdAt);
    expect(new Date(profile.createdAt).toString()).not.toBe('Invalid Date');
  });
});

describe('validateBillingInput', () => {
  it('accepts a fully valid billing body', () => {
    expect(validateBillingInput(validBilling())).toBeNull();
  });

  it('rejects a missing body', () => {
    expect(validateBillingInput(undefined)).toMatch(/JSON object/);
  });

  it('rejects a missing cardholderName', () => {
    const body = validBilling({ cardholderName: '' });
    expect(validateBillingInput(body)).toMatch(/cardholderName/);
  });

  it('rejects an unknown cardBrand', () => {
    const body = validBilling({ cardBrand: 'DINERS' });
    expect(validateBillingInput(body)).toMatch(/cardBrand/);
  });

  it.each(['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER'])('accepts cardBrand %s', (brand) => {
    expect(validateBillingInput(validBilling({ cardBrand: brand }))).toBeNull();
  });

  it('rejects a cardLast4 that is not exactly 4 digits', () => {
    expect(validateBillingInput(validBilling({ cardLast4: '123' }))).toMatch(/cardLast4/);
    expect(validateBillingInput(validBilling({ cardLast4: '12345' }))).toMatch(/cardLast4/);
    expect(validateBillingInput(validBilling({ cardLast4: 'abcd' }))).toMatch(/cardLast4/);
  });

  it('rejects a cardExpMonth out of range', () => {
    expect(validateBillingInput(validBilling({ cardExpMonth: 0 }))).toMatch(/cardExpMonth/);
    expect(validateBillingInput(validBilling({ cardExpMonth: 13 }))).toMatch(/cardExpMonth/);
    expect(validateBillingInput(validBilling({ cardExpMonth: 1.5 }))).toMatch(/cardExpMonth/);
  });

  it('rejects a cardExpYear outside current..+20', () => {
    expect(validateBillingInput(validBilling({ cardExpYear: currentYear - 1 }))).toMatch(/cardExpYear/);
    expect(validateBillingInput(validBilling({ cardExpYear: currentYear + 21 }))).toMatch(/cardExpYear/);
  });

  it('accepts the current year and current year + 20 as boundaries', () => {
    expect(validateBillingInput(validBilling({ cardExpYear: currentYear }))).toBeNull();
    expect(validateBillingInput(validBilling({ cardExpYear: currentYear + 20 }))).toBeNull();
  });

  it('rejects a missing paymentMethodToken', () => {
    expect(validateBillingInput(validBilling({ paymentMethodToken: '' }))).toMatch(/paymentMethodToken/);
  });

  it.each(['line1', 'city', 'postalCode', 'country'])(
    'rejects a billingAddress missing %s',
    (field) => {
      const body = validBilling({ billingAddress: { ...validBilling().billingAddress, [field]: '' } });
      expect(validateBillingInput(body)).toMatch(new RegExp(`billingAddress\\.${field}`));
    }
  );
});

describe('buildBillingRecord', () => {
  it('keeps only the recognised billing fields', () => {
    const body = validBilling({ extraField: 'strip me' });
    const record = buildBillingRecord(body);

    expect(record).toEqual(validBilling());
    expect(record.extraField).toBeUndefined();
  });
});

describe('containsForbiddenCardData — key-based rejection', () => {
  it.each(['cardNumber', 'number', 'pan', 'cvv', 'cvc', 'CVC', 'securityCode'])(
    'rejects a top-level key named %s',
    (key) => {
      expect(containsForbiddenCardData({ [key]: '123' })).toBe(true);
    }
  );

  it.each(['cardNumber', 'number', 'pan', 'cvv', 'cvc', 'CVC', 'securityCode'])(
    'rejects a nested (one level deep) key named %s',
    (key) => {
      expect(containsForbiddenCardData({ billing: { [key]: '123' } })).toBe(true);
    }
  );

  it('does not trip on cardholderName, cardBrand, cardLast4, cardExpMonth, cardExpYear keys', () => {
    expect(
      containsForbiddenCardData({
        cardholderName: 'Jane Doe',
        cardBrand: 'VISA',
        cardLast4: '1234',
        cardExpMonth: 6,
        cardExpYear: currentYear + 1,
      })
    ).toBe(false);
  });
});

describe('containsForbiddenCardData — value-based rejection', () => {
  it.each(['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111'])(
    'rejects the 16-digit PAN shape %s',
    (value) => {
      expect(containsForbiddenCardData({ anything: value })).toBe(true);
    }
  );

  it('rejects a 13-digit string', () => {
    expect(containsForbiddenCardData({ anything: '1234567890123' })).toBe(true);
  });

  it('rejects a 19-digit string', () => {
    expect(containsForbiddenCardData({ anything: '1234567890123456789' })).toBe(true);
  });

  it('does not reject a 12-digit string', () => {
    expect(containsForbiddenCardData({ anything: '123456789012' })).toBe(false);
  });

  it('does not reject a 20-digit string', () => {
    expect(containsForbiddenCardData({ anything: '12345678901234567890' })).toBe(false);
  });

  it('does not reject cardLast4 (4 digits)', () => {
    expect(containsForbiddenCardData({ cardLast4: '1234' })).toBe(false);
  });

  it('does not reject paymentMethodToken', () => {
    expect(containsForbiddenCardData({ paymentMethodToken: 'tok_abc123' })).toBe(false);
  });

  it('walks nested objects and arrays', () => {
    expect(
      containsForbiddenCardData({
        billingAddress: { line1: '123 Main St' },
        nested: [{ deeper: { value: '4111111111111111' } }],
      })
    ).toBe(true);
  });

  it('is false for a fully valid billing body', () => {
    expect(containsForbiddenCardData(validBilling())).toBe(false);
  });
});
