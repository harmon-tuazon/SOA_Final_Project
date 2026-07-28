import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { errorMessage } from '../../lib/api';
import { formatMoney, useCreateProduct, useProducts, type CreateProductInput } from './api';
import { StockBadge, Stars } from './ui';

// Product catalog — the "search results" half of an Amazon-style storefront:
// a category dropdown + keyword search that drive server-side filtering
// (?category=, ?q=), a grid of product cards linking into the detail page,
// and a collapsed create form.
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

  const isFiltered = Boolean(category || q);

  function handleSearchSubmit(e: FormEvent) {
    e.preventDefault();
    setQ(searchInput.trim());
  }

  function handleClearFilters() {
    setSearchInput('');
    setQ('');
    setCategory('');
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
      <div className="page-head">
        <h1>Products</h1>
        {!isLoading && !isError && products && (
          <span className="result-count">
            {products.length} {products.length === 1 ? 'result' : 'results'}
            {category ? ` in ${category}` : ''}
            {q ? ` for “${q}”` : ''}
          </span>
        )}
      </div>

      <form className="toolbar" onSubmit={handleSearchSubmit}>
        <label className="field">
          <span>Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <label className="field field--grow">
          <span>Search</span>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search name or description"
          />
        </label>

        <button type="submit">Search</button>
        {isFiltered && (
          <button type="button" onClick={handleClearFilters}>
            Clear
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
        <p>
          No products found.{' '}
          {isFiltered && (
            <button type="button" onClick={handleClearFilters}>
              Clear filters
            </button>
          )}
        </p>
      )}

      {!isLoading && !isError && products && products.length > 0 && (
        <ul className="product-grid">
          {products.map((product) => (
            <li key={product.id}>
              <article className="product-card">
                <Link to={`/products/${product.id}`} className="product-card__media">
                  {product.imageUrl ? (
                    <img src={product.imageUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="product-card__media--empty">No image</span>
                  )}
                </Link>

                <div className="product-card__body">
                  <h2 className="product-card__title">
                    <Link to={`/products/${product.id}`}>{product.name}</Link>
                  </h2>

                  <Stars rating={product.rating} />

                  <p className="product-card__price">{formatMoney(product.price)}</p>

                  <div className="product-card__meta">
                    <span>{product.category}</span>
                    <StockBadge stock={product.stock} />
                  </div>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}

      <details className="disclosure">
        <summary>Add a product</summary>
        <form onSubmit={handleCreateSubmit}>
          <div className="form-grid">
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Widget" />
            </label>
            <label className="field">
              <span>Category</span>
              <input
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                placeholder="Electronics"
              />
            </label>
            <label className="field">
              <span>Price</span>
              <input
                type="number"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="9.99"
              />
            </label>
            <label className="field">
              <span>Stock</span>
              <input
                type="number"
                step="1"
                value={stock}
                onChange={(e) => setStock(e.target.value)}
                placeholder="0"
              />
            </label>
            <label className="field form-grid--wide">
              <span>Image URL</span>
              <input
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="https://…"
              />
            </label>
            <label className="field form-grid--wide">
              <span>Description</span>
              <textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional"
              />
            </label>
          </div>

          <div className="form-actions">
            <button type="submit" disabled={createProduct.isPending}>
              {createProduct.isPending ? 'Creating…' : 'Create product'}
            </button>
            <span className="subtle">Rating starts at 0 — the server owns it.</span>
          </div>

          {createProduct.isError && (
            <p role="status">
              <strong>Could not create product.</strong> {errorMessage(createProduct.error)}
            </p>
          )}
        </form>
      </details>
    </section>
  );
}
