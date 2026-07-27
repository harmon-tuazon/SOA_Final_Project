import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import {
  formatDate,
  formatMoney,
  useCancelOrder,
  useCreateOrder,
  useOrders,
  type CreateOrderInput,
} from './api';

// "Your Orders" — the order-history list, modelled on the shape of an Amazon
// orders screen: one card per order with its placed date, total, status, a
// line-item summary, and the actions the service actually permits.
//
// Like every page here it must handle the "backend unavailable" state
// gracefully: the order service may not be deployed yet (its Terraform is a
// pending DevOps handoff — see docs/action_plan/order/0001-service-scaffold.md).

/** A fixed sample basket, so the demo can place an order without a cart/product service. */
const DEMO_ORDER: Omit<CreateOrderInput, 'customerId'> = {
  items: [
    { productId: 'p-1001', name: 'Mechanical Keyboard', unitPrice: 89.99, qty: 1 },
    { productId: 'p-1002', name: 'USB-C Cable (2m)', unitPrice: 12.5, qty: 2 },
  ],
  shippingAddress: {
    line1: '1 Demo Street',
    city: 'Toronto',
    postalCode: 'M5V 2T6',
    country: 'CA',
  },
};

export function OrdersPage() {
  const { user } = useAuth();
  const customerId = user?.id ?? '';

  const [mineOnly, setMineOnly] = useState(true);
  const { data: orders, isLoading, isError, error } = useOrders(mineOnly ? customerId : undefined);

  const createOrder = useCreateOrder();
  const cancelOrder = useCancelOrder();

  function handlePlaceDemoOrder(e?: FormEvent) {
    e?.preventDefault();
    createOrder.mutate({ ...DEMO_ORDER, customerId });
  }

  return (
    <section>
      <h1>Your Orders</h1>

      <p>
        <Link className="btn--primary" to="/orders/new">
          + Place a new order
        </Link>{' '}
        — choose your own items and shipping address.
      </p>

      <p>
        <label>
          <input
            type="checkbox"
            checked={mineOnly}
            onChange={(e) => setMineOnly(e.target.checked)}
          />{' '}
          Show only my orders{customerId ? ` (${customerId})` : ''}
        </label>
      </p>

      <form onSubmit={handlePlaceDemoOrder}>
        <button type="button" className="btn" onClick={() => handlePlaceDemoOrder()} disabled={createOrder.isPending || !customerId}>
          {createOrder.isPending ? 'Placing order…' : 'Place a demo order (sample basket)'}
        </button>
        {createOrder.isError && (
          <p role="status">
            <strong>Could not place the order.</strong>{' '}
            {createOrder.error instanceof Error ? createOrder.error.message : ''}
          </p>
        )}
      </form>

      {isLoading && <p>Loading orders…</p>}

      {isError && (
        <div role="status">
          <strong>Backend unavailable.</strong>{' '}
          <span>{error instanceof Error ? error.message : 'Could not load orders.'}</span>
        </div>
      )}

      {!isLoading && !isError && orders && orders.length === 0 && (
        <p>No orders yet. Place one above to see it here.</p>
      )}

      {!isLoading && !isError && orders && orders.length > 0 && (
        <ul className="order-list">
          {orders.map((order) => (
            <li key={order.id}>
              <article className="order-card">
                <dl className="order-card__bar">
                  <div>
                    <dt>Order placed</dt>
                    <dd>{formatDate(order.placedAt)}</dd>
                  </div>
                  <div>
                    <dt>Total</dt>
                    <dd>{formatMoney(order.total)}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>
                      <span className="badge" data-status={order.status}>
                        {order.status}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>{order.status === 'DELIVERED' ? 'Delivered' : 'Est. delivery'}</dt>
                    <dd>{formatDate(order.deliveryEstimate)}</dd>
                  </div>
                </dl>

                <div className="order-card__body">
                  <h2>
                    <Link to={`/orders/${order.id}`}>Order #{order.id.slice(0, 8)}</Link>
                  </h2>

                  <ul className="line-items">
                    {order.items.map((item) => (
                      <li key={item.productId}>
                        {item.name} × {item.qty} — {formatMoney(item.unitPrice * item.qty)}
                      </li>
                    ))}
                  </ul>

                  <div className="order-actions">
                    <Link className="btn" to={`/orders/${order.id}`}>
                      View order details
                    </Link>

                    {/* The service only allows cancelling from PLACED and answers
                        409 otherwise, so the button follows the same rule. */}
                    {order.status === 'PLACED' && (
                      <button
                        type="button"
                        className="btn--danger"
                        onClick={() => cancelOrder.mutate(order.id)}
                        disabled={cancelOrder.isPending}
                      >
                        {cancelOrder.isPending ? 'Cancelling…' : 'Cancel order'}
                      </button>
                    )}
                  </div>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}

      {cancelOrder.isError && (
        <p role="status">
          <strong>Could not cancel the order.</strong>{' '}
          {cancelOrder.error instanceof Error ? cancelOrder.error.message : ''}
        </p>
      )}
    </section>
  );
}
