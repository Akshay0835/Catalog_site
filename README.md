# Fast Paginated Catalog Engine

A high-performance backend catalog serving ~200,000 products. Built with **Node.js (Express)** and **SQLite (better-sqlite3)**.

It achieves average query times of **<0.1 ms per page** using **Keyset (Cursor-based) Pagination** and compound index optimization, guaranteeing stable, consistent views even when background updates or inserts occur.

---

## The Concurrency & Pagination Challenge

When database records are changing (e.g., 50 new items added or existing items updated) while a user is paginating:

### Why Offset-based Pagination Fails (`LIMIT 20 OFFSET 40`)
1. **Duplicates**: If a user is viewing Page 1, and 50 new products are inserted at the beginning, the existing products shift down by 50 slots. When the user requests Page 2 (offset 20), they will see items they already saw on Page 1 because those items shifted down.
2. **Skips**: If products are deleted, offset-based pagination skips items because they shift up.

### How Keyset (Cursor-based) Pagination Solves It
Instead of offset numbers, the client sends a **cursor** representing the last seen product's sorting attributes: `(created_at, id)`.
The database query uses inequality filters to fetch only records strictly older than the cursor:
```sql
SELECT * FROM products
WHERE (created_at < :cursor_created_at) 
   OR (created_at = :cursor_created_at AND id < :cursor_id)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```
- **New Insertions**: When new products are added, they get newer timestamps. Since the cursor only requests products *older* than the current page's last item, the new items are automatically excluded from subsequent pages. The user can paginate down to the bottom without ever seeing a duplicate or missing an item.
- **Updates**: Because sorting is done by `created_at DESC, id DESC` and these fields are immutable, the order of products in the catalog remains entirely stable. Any updates to prices or names reflect immediately, but the product positions never shift, preventing any double-delivery or omission.

---

## Performance Design

To ensure fast pagination at 200,000+ rows, we created two tailored compound indexes:
1. **Global Feed Index**: `(created_at DESC, id DESC)`
2. **Category Feed Index**: `(category, created_at DESC, id DESC)`

SQLite is configured in **WAL (Write-Ahead Logging) Mode**, allowing concurrent reads and writes without blocking each other.

### Benchmark Results
- **Seed Time**: 200,000 products generated and inserted in **~0.5 seconds**.
- **Pagination Query Latency**: **~0.04 ms per page request** (fully indexed scan with no filesort).

---

## Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Seed the Database
This runs the high-performance seed script to generate 200,000 products:
```bash
npm run seed
```

### 3. Start the Server
```bash
npm start
```
The server will default to port 3000. If port 3000 is occupied, it automatically increments and binds to the first free port (e.g. 3001, 3002). The bound address is logged to the console output.

### 4. Verify Indexes & Performance
To verify index plans and check query latency:
```bash
node db/verify.js
```

### 5. Verify Advanced Backend Features
To verify the query cache, cryptographic signature security, sliding rate limiter, and graceful shutdowns, run:
```bash
node db/verify_advanced.js
```

---

## Verifying Concurrency (Interactive Web UI)

Open the catalog URL (e.g. [http://localhost:3000](http://localhost:3000) or [http://localhost:3001](http://localhost:3001)) in your browser:
1. Use **Category Filters** to filter products or paginate through the global list.
2. Click **Load More Products** to paginate down.
3. Mid-session, click **Add 50 New Products** or **Update 50 Products** on the sidebar.
4. Continue paginating. The UI automatically tracks loaded IDs and will display a prominent warning banner if a duplicate product ID is ever delivered. (You will notice zero warnings because the keyset cursor prevents duplicate delivery!)
