import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { formatMoney, useCreateOrder, type CreateOrderInput } from './api';

// "Place a new order" — the real order-entry screen the demo button on
// OrdersPage stands in for. It builds a full CreateOrderInput (line items +
// shipping address) and posts it through the same useCreateOrder mutation, so
// the server stays authoritative for id/total/status/placedAt. On success we
// route to the created order's detail page.
//
// Item/address shapes and the client-side checks below mirror the service's
// validation (services/order/src/orders.js) so a well-formed form never trips
// a 400 — but we still surface the server error if one comes back.

/** Form-local row: inputs are strings; parsed to numbers only on submit. */
interface ItemRow {
  productId: string;
  name: string;
  unitPrice: string;
  qty: string;
}

/** A fresh line-item row with a generated productId (editable). */
function blankRow(): ItemRow {
  return {
    productId: `p-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    unitPrice: '',
    qty: '1',
  };
}

const BLANK_ADDRESS: CreateOrderInput['shippingAddress'] = {
  line1: '',
  city: '',
  postalCode: '',
  country: '',
};

/** Subtotal for a row, or 0 when the inputs aren't yet valid numbers. */
function rowSubtotal(row: ItemRow): number {
  const price = Number(row.unitPrice);
  const qty = Number(row.qty);
  if (!Number.isFinite(price) || !Number.isFinite(qty)) return 0;
  return price * qty;
}

export function NewOrderPage() {
  const { user } = useAuth();
  const customerId = user?.id ?? '';
  const navigate = useNavigate();
  const createOrder = useCreateOrder();

  const [items, setItems] = useState<ItemRow[]>([blankRow()]);
  const [address, setAddress] =
    useState<CreateOrderInput['shippingAddress']>(BLANK_ADDRESS);
  const [formError, setFormError] = useState<string | null>(null);

  const total = items.reduce((sum, row) => sum + rowSubtotal(row), 0);

  function updateItem(index: number, patch: Partial<ItemRow>) {
    setItems((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addItem() {
    setItems((rows) => [...rows, blankRow()]);
  }

  function removeItem(index: number) {
    setItems((rows) => (rows.length === 1 ? rows : rows.filter((_, i) => i !== index)));
  }

  /** Validates and converts the form into a CreateOrderInput, or returns an error string. */
  function buildInput(): CreateOrderInput | string {
    if (!customerId) {
      return 'You must be signed in to place an order.';
    }

    const parsedItems = items.map((row) => ({
      productId: row.productId.trim(),
      name: row.name.trim(),
      unitPrice: Number(row.unitPrice),
      qty: Number(row.qty),
    }));

    for (let i = 0; i < parsedItems.length; i += 1) {
      const item = parsedItems[i];
      const label = `Item ${i + 1}`;
      if (!item.productId) return `${label}: product id is required.`;
      if (!item.name) return `${label}: name is required.`;
      if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) {
        return `${label}: unit price must be a number ≥ 0.`;
      }
      if (!Number.isInteger(item.qty) || item.qty < 1) {
        return `${label}: quantity must be a whole number ≥ 1.`;
      }
    }

    for (const [field, value] of Object.entries(address)) {
      if (!value.trim()) {
        return `Shipping address: ${field} is required.`;
      }
    }

    return {
      customerId,
      items: parsedItems,
      shippingAddress: {
        line1: address.line1.trim(),
        city: address.city.trim(),
        postalCode: address.postalCode.trim(),
        country: address.country.trim(),
      },
    };
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const input = buildInput();
    if (typeof input === 'string') {
      setFormError(input);
      return;
    }
    setFormError(null);
    createOrder.mutate(input, {
      onSuccess: (order) => navigate(`/orders/${order.id}`),
    });
  }

  return (
    <section>
      <p>
        <Link to="/orders">← Back to your orders</Link>
      </p>

      <h1>Place a new order</h1>
      <p>Ordering as {customerId || '(not signed in)'}.</p>

      <form onSubmit={handleSubmit}>
        <h2>Items</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Product id</th>
              <th scope="col">Name</th>
              <th scope="col">Unit price</th>
              <th scope="col">Qty</th>
              <th scope="col">Subtotal</th>
              <th scope="col">
                <span aria-hidden="true">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((row, index) => (
              <tr key={index}>
                <td>
                  <input
                    aria-label={`Item ${index + 1} product id`}
                    value={row.productId}
                    onChange={(e) => updateItem(index, { productId: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    aria-label={`Item ${index + 1} name`}
                    value={row.name}
                    placeholder="Mechanical Keyboard"
                    onChange={(e) => updateItem(index, { name: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    aria-label={`Item ${index + 1} unit price`}
                    type="number"
                    step="0.01"
                    min="0"
                    value={row.unitPrice}
                    placeholder="9.99"
                    onChange={(e) => updateItem(index, { unitPrice: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    aria-label={`Item ${index + 1} quantity`}
                    type="number"
                    step="1"
                    min="1"
                    value={row.qty}
                    onChange={(e) => updateItem(index, { qty: e.target.value })}
                  />
                </td>
                <td>{formatMoney(rowSubtotal(row))}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => removeItem(index)}
                    disabled={items.length === 1}
                    aria-label={`Remove item ${index + 1}`}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={4}>
                Order total
              </th>
              <td>{formatMoney(total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>

        <p>
          <button type="button" onClick={addItem}>
            + Add item
          </button>
        </p>

        <h2>Shipping address</h2>
        <p>
          <label>
            Address line 1{' '}
            <input
              value={address.line1}
              placeholder="1 Demo Street"
              onChange={(e) => setAddress({ ...address, line1: e.target.value })}
            />
          </label>
        </p>
        <p>
          <label>
            City{' '}
            <input
              value={address.city}
              placeholder="Toronto"
              onChange={(e) => setAddress({ ...address, city: e.target.value })}
            />
          </label>
        </p>
        <p>
          <label>
            Postal code{' '}
            <input
              value={address.postalCode}
              placeholder="M5V 2T6"
              onChange={(e) => setAddress({ ...address, postalCode: e.target.value })}
            />
          </label>
        </p>
        <p>
          <label>
            Country{' '}
            <input
              value={address.country}
              placeholder="CA"
              onChange={(e) => setAddress({ ...address, country: e.target.value })}
            />
          </label>
        </p>

        <p>
          <button type="submit" disabled={createOrder.isPending || !customerId}>
            {createOrder.isPending ? 'Placing order…' : 'Place order'}
          </button>
        </p>

        {formError && (
          <p role="status">
            <strong>Please fix this first.</strong> {formError}
          </p>
        )}

        {createOrder.isError && (
          <p role="status">
            <strong>Could not place the order.</strong>{' '}
            {createOrder.error instanceof Error ? createOrder.error.message : ''}
          </p>
        )}
      </form>
    </section>
  );
}
