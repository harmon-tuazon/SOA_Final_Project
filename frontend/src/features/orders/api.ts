import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api';

// Order feature — talks to the `order` service (services/order/) through the
// shared apiFetch wrapper, so the ALB base URL stays a runtime config value
// and is never hardcoded here. See docs/operations/adding-a-frontend-feature.md.

export type OrderStatus = 'PLACED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';

export interface OrderItem {
  productId: string;
  name: string;
  unitPrice: number;
  qty: number;
}

export interface ShippingAddress {
  line1: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface Order {
  id: string;
  customerId: string;
  status: OrderStatus;
  items: OrderItem[];
  total: number;
  placedAt: string;
  shippingAddress: ShippingAddress;
  deliveryEstimate: string;
  updatedAt: string;
}

/**
 * What the client may send on create. The server derives id, total, status,
 * placedAt, deliveryEstimate and updatedAt and ignores any client-supplied
 * values for them — so they are deliberately absent from this type.
 */
export interface CreateOrderInput {
  customerId: string;
  items: OrderItem[];
  shippingAddress: ShippingAddress;
}

const ORDERS_KEY = ['orders'] as const;

const orderKey = (id: string) => ['orders', id] as const;

/** Lists orders, newest first. Pass a customerId to see only that customer's. */
export function useOrders(customerId?: string) {
  return useQuery({
    queryKey: customerId ? [...ORDERS_KEY, { customerId }] : ORDERS_KEY,
    queryFn: () =>
      apiFetch<Order[]>(
        customerId ? `/orders?customerId=${encodeURIComponent(customerId)}` : '/orders',
      ),
    retry: false,
  });
}

/** Fetches a single order for the detail page. */
export function useOrder(id: string) {
  return useQuery({
    queryKey: orderKey(id),
    queryFn: () => apiFetch<Order>(`/orders/${encodeURIComponent(id)}`),
    retry: false,
    enabled: Boolean(id),
  });
}

/** Places an order and refreshes the order list on success. */
export function useCreateOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateOrderInput) =>
      apiFetch<Order>('/orders', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ORDERS_KEY });
    },
  });
}

/**
 * Cancels an order. The service only allows this from PLACED and answers 409
 * otherwise, so callers should surface the error rather than assume success.
 */
export function useCancelOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<Order>(`/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
    onSuccess: (order) => {
      queryClient.invalidateQueries({ queryKey: ORDERS_KEY });
      queryClient.invalidateQueries({ queryKey: orderKey(order.id) });
    },
  });
}

/**
 * Advances an order's status. Only PLACED -> SHIPPED and SHIPPED -> DELIVERED
 * are legal; anything else comes back as a 409 from the service.
 */
export function useUpdateOrderStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: OrderStatus }) =>
      apiFetch<Order>(`/orders/${encodeURIComponent(id)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    onSuccess: (order) => {
      queryClient.invalidateQueries({ queryKey: ORDERS_KEY });
      queryClient.invalidateQueries({ queryKey: orderKey(order.id) });
    },
  });
}

/** The next legal status, or null when the order is in a terminal state. */
export function nextStatus(status: OrderStatus): OrderStatus | null {
  if (status === 'PLACED') return 'SHIPPED';
  if (status === 'SHIPPED') return 'DELIVERED';
  return null;
}

export function formatMoney(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}
