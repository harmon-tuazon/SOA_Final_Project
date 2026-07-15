import { useState, type FormEvent } from 'react';
import { useCreateProduct, useProducts } from './api';

// Worked example page — pairs with ./api.ts. Copy this shape for new
// features: a query + mutation hook file, and a page that consumes them and
// handles the "backend unavailable" state gracefully (there is no backend
// deployed yet, so this state is expected, not an error to hide).

export function ProductsPage() {
  const { data: products, isLoading, isError, error } = useProducts();
  const createProduct = useCreateProduct();

  const [name, setName] = useState('');
  const [price, setPrice] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const parsedPrice = Number(price);
    if (!name.trim() || Number.isNaN(parsedPrice)) {
      return;
    }
    createProduct.mutate(
      { name: name.trim(), price: parsedPrice },
      {
        onSuccess: () => {
          setName('');
          setPrice('');
        },
      },
    );
  }

  return (
    <section>
      <h1>Products</h1>
      <p>
        This page demonstrates a React Query <code>useQuery</code> + <code>useMutation</code>{' '}
        round-trip through <code>apiFetch</code>. No product service is deployed yet, so the
        "backend unavailable" state below is expected.
      </p>

      {isLoading && <p>Loading products…</p>}

      {isError && (
        <div role="status">
          <strong>Backend unavailable.</strong>{' '}
          <span>{error instanceof Error ? error.message : 'Could not load products.'}</span>
        </div>
      )}

      {!isLoading && !isError && products && products.length === 0 && (
        <p>No products yet.</p>
      )}

      {!isLoading && !isError && products && products.length > 0 && (
        <ul>
          {products.map((product) => (
            <li key={product.id}>
              {product.name} — ${product.price.toFixed(2)}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleSubmit}>
        <h2>Create product</h2>
        <label>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Widget"
          />
        </label>
        <label>
          Price
          <input
            type="number"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="9.99"
          />
        </label>
        <button type="submit" disabled={createProduct.isPending}>
          {createProduct.isPending ? 'Creating…' : 'Create'}
        </button>

        {createProduct.isError && (
          <p role="status">
            <strong>Could not create product.</strong>{' '}
            {createProduct.error instanceof Error ? createProduct.error.message : ''}
          </p>
        )}
      </form>
    </section>
  );
}
