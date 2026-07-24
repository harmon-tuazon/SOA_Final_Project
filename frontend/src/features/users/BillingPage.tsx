import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useBilling, useDeleteBilling, usePutBilling, type Billing, type CardBrand } from './api';

// Billing page — deliberately collects only non-sensitive card *metadata*
// (brand, last 4 digits, expiry, an opaque payment-method token standing in
// for a PSP token) plus a billing address. There is intentionally no full
// card-number or CVV field anywhere in this form: services/user rejects any
// such value with 400 before it reaches the database or the logs
// (PRD user/0001 §3.3) — the UI simply never offers the field to begin with.

const CARD_BRANDS: CardBrand[] = ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER'];

const EMPTY_FORM = {
  cardholderName: '',
  cardBrand: 'VISA' as CardBrand,
  cardLast4: '',
  cardExpMonth: '',
  cardExpYear: '',
  paymentMethodToken: '',
  line1: '',
  city: '',
  postalCode: '',
  country: '',
};

export function BillingPage() {
  const { data: billing, isLoading, isError, error } = useBilling();
  const putBilling = usePutBilling();
  const deleteBilling = useDeleteBilling();

  const [form, setForm] = useState(EMPTY_FORM);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (billing) {
      setForm({
        cardholderName: billing.cardholderName,
        cardBrand: billing.cardBrand,
        cardLast4: billing.cardLast4,
        cardExpMonth: String(billing.cardExpMonth),
        cardExpYear: String(billing.cardExpYear),
        paymentMethodToken: billing.paymentMethodToken,
        line1: billing.billingAddress.line1,
        city: billing.billingAddress.city,
        postalCode: billing.billingAddress.postalCode,
        country: billing.billingAddress.country,
      });
    }
  }, [billing]);

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);

    if (!/^\d{4}$/.test(form.cardLast4)) {
      setValidationError('Card last 4 digits must be exactly 4 digits.');
      return;
    }
    const expMonth = Number(form.cardExpMonth);
    const expYear = Number(form.cardExpYear);
    if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12) {
      setValidationError('Expiry month must be between 1 and 12.');
      return;
    }
    if (!Number.isInteger(expYear)) {
      setValidationError('Expiry year is invalid.');
      return;
    }

    const payload: Billing = {
      cardholderName: form.cardholderName,
      cardBrand: form.cardBrand,
      cardLast4: form.cardLast4,
      cardExpMonth: expMonth,
      cardExpYear: expYear,
      paymentMethodToken: form.paymentMethodToken,
      billingAddress: {
        line1: form.line1,
        city: form.city,
        postalCode: form.postalCode,
        country: form.country,
      },
    };

    putBilling.mutate(payload);
  }

  function handleDelete() {
    deleteBilling.mutate(undefined, {
      onSuccess: () => setForm(EMPTY_FORM),
    });
  }

  if (isLoading) {
    return <p>Loading billing information…</p>;
  }

  if (isError) {
    return (
      <section>
        <h1>Billing information</h1>
        <div role="status">
          <strong>Backend unavailable.</strong>{' '}
          <span>
            {error instanceof Error ? error.message : 'Could not load billing information.'}
          </span>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h1>Billing information</h1>
      <p>
        <Link to="/profile">← Back to your profile</Link>
      </p>

      <p role="note">
        <strong>Note:</strong> only non-sensitive card metadata is stored here (brand, last 4
        digits, expiry, and an opaque payment token) — never a full card number or CVV. Requests
        containing either are rejected before they reach the server.
      </p>

      {!billing && <p>No billing information saved yet.</p>}

      <form onSubmit={handleSubmit}>
        <label>
          Cardholder name
          <input
            required
            value={form.cardholderName}
            onChange={(e) => update('cardholderName', e.target.value)}
          />
        </label>
        <label>
          Card brand
          <select
            value={form.cardBrand}
            onChange={(e) => update('cardBrand', e.target.value as CardBrand)}
          >
            {CARD_BRANDS.map((brand) => (
              <option key={brand} value={brand}>
                {brand}
              </option>
            ))}
          </select>
        </label>
        <label>
          Card last 4 digits
          <input
            required
            inputMode="numeric"
            pattern="[0-9]{4}"
            maxLength={4}
            value={form.cardLast4}
            onChange={(e) => update('cardLast4', e.target.value)}
          />
        </label>
        <label>
          Expiry month
          <input
            required
            type="number"
            min={1}
            max={12}
            value={form.cardExpMonth}
            onChange={(e) => update('cardExpMonth', e.target.value)}
          />
        </label>
        <label>
          Expiry year
          <input
            required
            type="number"
            min={new Date().getFullYear()}
            max={new Date().getFullYear() + 20}
            value={form.cardExpYear}
            onChange={(e) => update('cardExpYear', e.target.value)}
          />
        </label>
        <label>
          Payment method token
          <input
            required
            value={form.paymentMethodToken}
            onChange={(e) => update('paymentMethodToken', e.target.value)}
            placeholder="Opaque PSP token — never a card number"
          />
        </label>

        <h2>Billing address</h2>
        <label>
          Address line 1
          <input required value={form.line1} onChange={(e) => update('line1', e.target.value)} />
        </label>
        <label>
          City
          <input required value={form.city} onChange={(e) => update('city', e.target.value)} />
        </label>
        <label>
          Postal code
          <input
            required
            value={form.postalCode}
            onChange={(e) => update('postalCode', e.target.value)}
          />
        </label>
        <label>
          Country
          <input
            required
            value={form.country}
            onChange={(e) => update('country', e.target.value)}
          />
        </label>

        {validationError && (
          <p role="status">
            <strong>{validationError}</strong>
          </p>
        )}

        <button type="submit" disabled={putBilling.isPending}>
          {putBilling.isPending ? 'Saving…' : billing ? 'Replace billing info' : 'Save billing info'}
        </button>

        {billing && (
          <button type="button" onClick={handleDelete} disabled={deleteBilling.isPending}>
            {deleteBilling.isPending ? 'Removing…' : 'Remove billing info'}
          </button>
        )}

        {putBilling.isError && (
          <p role="status">
            <strong>Could not save billing information.</strong>{' '}
            {putBilling.error instanceof Error ? putBilling.error.message : ''}
          </p>
        )}
        {putBilling.isSuccess && <p role="status">Saved.</p>}

        {deleteBilling.isError && (
          <p role="status">
            <strong>Could not remove billing information.</strong>{' '}
            {deleteBilling.error instanceof Error ? deleteBilling.error.message : ''}
          </p>
        )}
      </form>
    </section>
  );
}
