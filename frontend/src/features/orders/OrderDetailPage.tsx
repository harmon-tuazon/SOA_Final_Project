import { Link, useParams } from 'react-router-dom';
import {
  formatDate,
  formatMoney,
  nextStatus,
  useCancelOrder,
  useOrder,
  useUpdateOrderStatus,
} from './api';

// Order detail — the "order summary" half of an Amazon orders screen: the
// shipping address, the full line-item table with a computed total, and the
// status actions the service permits from the order's current state.
//
// The status-advance control exists because there is no fulfilment system in
// this project; it stands in for whatever would otherwise move an order along.

export function OrderDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { data: order, isLoading, isError, error } = useOrder(id);

  const updateStatus = useUpdateOrderStatus();
  const cancelOrder = useCancelOrder();

  if (isLoading) {
    return <p>Loading order…</p>;
  }

  if (isError) {
    return (
      <section>
        <p>
          <Link to="/orders">← Back to your orders</Link>
        </p>
        <div role="status">
          <strong>Could not load this order.</strong>{' '}
          <span>{error instanceof Error ? error.message : ''}</span>
        </div>
      </section>
    );
  }

  if (!order) {
    return (
      <section>
        <p>
          <Link to="/orders">← Back to your orders</Link>
        </p>
        <p>Order not found.</p>
      </section>
    );
  }

  const advanceTo = nextStatus(order.status);

  return (
    <section>
      <p>
        <Link to="/orders">← Back to your orders</Link>
      </p>

      <h1>Order {order.id}</h1>

      <dl>
        <dt>Status</dt>
        <dd>{order.status}</dd>
        <dt>Placed</dt>
        <dd>{formatDate(order.placedAt)}</dd>
        <dt>{order.status === 'DELIVERED' ? 'Delivered' : 'Estimated delivery'}</dt>
        <dd>{formatDate(order.deliveryEstimate)}</dd>
        <dt>Customer</dt>
        <dd>{order.customerId}</dd>
        <dt>Last updated</dt>
        <dd>{formatDate(order.updatedAt)}</dd>
      </dl>

      <h2>Shipping address</h2>
      <address>
        {order.shippingAddress.line1}
        <br />
        {order.shippingAddress.city} {order.shippingAddress.postalCode}
        <br />
        {order.shippingAddress.country}
      </address>

      <h2>Items</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Unit price</th>
            <th scope="col">Qty</th>
            <th scope="col">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((item) => (
            <tr key={item.productId}>
              <td>{item.name}</td>
              <td>{formatMoney(item.unitPrice)}</td>
              <td>{item.qty}</td>
              <td>{formatMoney(item.unitPrice * item.qty)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={3}>
              Order total
            </th>
            <td>{formatMoney(order.total)}</td>
          </tr>
        </tfoot>
      </table>

      <h2>Actions</h2>

      {advanceTo && (
        <button
          type="button"
          onClick={() => updateStatus.mutate({ id: order.id, status: advanceTo })}
          disabled={updateStatus.isPending}
        >
          {updateStatus.isPending ? 'Updating…' : `Mark as ${advanceTo}`}
        </button>
      )}

      {order.status === 'PLACED' && (
        <button
          type="button"
          onClick={() => cancelOrder.mutate(order.id)}
          disabled={cancelOrder.isPending}
        >
          {cancelOrder.isPending ? 'Cancelling…' : 'Cancel order'}
        </button>
      )}

      {!advanceTo && order.status !== 'PLACED' && (
        <p>No further actions — this order is {order.status.toLowerCase()}.</p>
      )}

      {updateStatus.isError && (
        <p role="status">
          <strong>Could not update the status.</strong>{' '}
          {updateStatus.error instanceof Error ? updateStatus.error.message : ''}
        </p>
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
