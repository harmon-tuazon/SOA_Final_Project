import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { errorMessage } from '../../lib/api';
import { formatMoney, useCreateProduct, useProducts, type CreateProductInput } from './api';

// Product catalog — the "search results" half of an Amazon-style storefront:
// a category dropdown + keyword search that drive server-side filtering
// (?category=, ?q=), a grid of products linking into the detail page, and a
// create form.
//
// Like every page here it must handle the "backend unavailable" state
// gracefully: the product service may not be deployed yet.

export function ProductsPage() {
  const [category, setCategory] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');

  const {
    data: products,
    isLoading,
    isError,
    error,
  } = useProducts({ category: category || undefined, q: q || undefined });

  // A separate, unfiltered fetch purely to populate the category dropdown —
  // deriving options from the (possibly filtered) `products` list above
  // would shrink the dropdown to whatever is currently showing and trap the
  // user in one category.
  const { data: allProducts } = useProducts();
  const categories = useMemo(() => {
    const set = new Set<string>();
    (allProducts ?? []).forEach((p) => set.add(p.category));
    return Array.from(set).sort();
  }, [allProducts]);

  const createProduct = useCreateProduct();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [stock, setStock] = useState('');

  function handleSearchSubmit(e: FormEvent) {
    e.preventDefault();
    setQ(searchInput.trim());
  }

  function handleClearSearch() {
    setSearchInput('');
    setQ('');
  }

  function handleCreateSubmit(e: FormEvent) {
    e.preventDefault();
    const parsedPrice = Number(price);
    if (!name.trim() || !newCategory.trim() || Number.isNaN(parsedPrice)) {
      return;
    }

    const input: CreateProductInput = {
      name: name.trim(),
      price: parsedPrice,
      category: newCategory.trim(),
    };
    if (description.trim()) {
      input.description = description.trim();
    }
    if (imageUrl.trim()) {
      input.imageUrl = imageUrl.trim();
    }
    if (stock.trim()) {
      const parsedStock = Number(stock);
      if (!Number.isNaN(parsedStock)) {
        input.stock = parsedStock;
      }
    }

    createProduct.mutate(input, {
      onSuccess: () => {
        setName('');
        setDescription('');
        setPrice('');
        setNewCategory('');
        setImageUrl('');
        setStock('');
      },
    });
  }

  return (
    <section>
      <h1>Products</h1>

      <p>
        <label>
          Category{' '}
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </p>

      <form onSubmit={handleSearchSubmit}>
        <label>
          Search{' '}
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search name or description"
          />
        </label>{' '}
        <button type="submit">Search</button>{' '}
        {q && (
          <button type="button" onClick={handleClearSearch}>
            Clear search
          </button>
        )}
      </form>

      {isLoading && <p>Loading products…</p>}

      {isError && (
        <div role="status">
          <strong>Backend unavailable.</strong>{' '}
          <span>{error instanceof Error ? error.message : 'Could not load products.'}</span>
        </div>
      )}

      {!isLoading && !isError && products && products.length === 0 && (
        <p>No products found.</p>
      )}

      {!isLoading && !isError && products && products.length > 0 && (
        <ul>
          {products.map((product) => (
            <li key={product.id}>
              <article>
                <h2>
                  <Link to={`/products/${product.id}`}>{product.name}</Link>
                </h2>

                {product.imageUrl ? (
                  <img src={product.imageUrl} alt={product.name} width={120} />
                ) : (
                  <p>No image</p>
                )}

                <dl>
                  <dt>Price</dt>
                  <dd>{formatMoney(product.price)}</dd>
                  <dt>Category</dt>
                  <dd>{product.category}</dd>
                  <dt>Rating</dt>
                  <dd>{product.rating.toFixed(1)} / 5</dd>
                  <dt>Stock</dt>
                  <dd>{product.stock === 0 ? 'Out of stock' : product.stock}</dd>
                </dl>

                <p>
                  <Link to={`/products/${product.id}`}>View details</Link>
                </p>
              </article>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleCreateSubmit}>
        <h2>Create product</h2>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Widget" />
        </label>
        <label>
          Description
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
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
        <label>
          Category
          <input
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            placeholder="Electronics"
          />
        </label>
        <label>
          Image URL
          <input
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="https://…"
          />
        </label>
        <label>
          Stock
          <input
            type="number"
            step="1"
            value={stock}
            onChange={(e) => setStock(e.target.value)}
            placeholder="0"
          />
        </label>
        <button type="submit" disabled={createProduct.isPending}>
          {createProduct.isPending ? 'Creating…' : 'Create'}
        </button>

        {createProduct.isError && (
          <p role="status">
            <strong>Could not create product.</strong>{' '}
            {errorMessage(createProduct.error)}
          </p>
        )}
      </form>
    </section>
  );
}
