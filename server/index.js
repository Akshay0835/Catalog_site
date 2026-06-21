import express from 'express';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.resolve(__dirname, '../db/products.db');
const PORT = process.env.PORT || 3000;

// Initialize database connection
const db = new Database(DB_PATH, { fileMustExist: true });

// Enable WAL journal mode for optimal concurrent read/write performance
db.pragma('journal_mode = WAL');

const app = express();
app.use(express.json());
app.use(express.static(path.resolve(__dirname, '../public')));

// Trust proxy for accurate client IP identification (behind proxies/gateways)
app.set('trust proxy', true);

// =========================================================================
// 1. Cryptographic Cursor Signing
// =========================================================================
// Generate a cryptographically secure random key on start to sign pagination tokens.
// Tampered cursors will fail signature validation and return 400 Bad Request.
const CURSOR_SECRET = crypto.randomBytes(32).toString('hex');

function encodeCursor(createdAt, id) {
  const payload = JSON.stringify({ created_at: createdAt, id });
  // Generate HMAC signature of the payload
  const signature = crypto.createHmac('sha256', CURSOR_SECRET).update(payload).digest('hex');
  const signedObj = { payload, signature };
  // Base64Url encoding is safe for URL queries
  return Buffer.from(JSON.stringify(signedObj)).toString('base64url');
}

function decodeCursor(cursorStr) {
  try {
    const raw = Buffer.from(cursorStr, 'base64url').toString('utf8');
    const { payload, signature } = JSON.parse(raw);

    // Verify cryptographic signature matches to prevent client tampering
    const expectedSignature = crypto.createHmac('sha256', CURSOR_SECRET).update(payload).digest('hex');
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
      console.warn('[Security] Tampered cursor signature detected!');
      return null;
    }

    return JSON.parse(payload);
  } catch (err) {
    return null;
  }
}

// =========================================================================
// 2. Automated Keyset Query Cache
// =========================================================================
class QueryCache {
  constructor(ttlMs = 30000) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return item.data;
  }

  set(key, value) {
    this.cache.set(key, {
      data: value,
      expiresAt: Date.now() + this.ttlMs
    });
  }

  clear() {
    this.cache.clear();
    console.log('[Cache] In-memory catalog cache cleared due to write database activity.');
  }
}

const catalogCache = new QueryCache(30000); // 30s TTL cache

// =========================================================================
// 3. Sliding Window Rate Limiter
// =========================================================================
class SlidingWindowLimiter {
  constructor(windowMs = 60000, maxRequests = 60) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.clients = new Map(); // IP -> Array of request timestamps
  }

  isRateLimited(ip) {
    const now = Date.now();
    if (!this.clients.has(ip)) {
      this.clients.set(ip, [now]);
      return false;
    }

    const timestamps = this.clients.get(ip);
    // Filter timestamps keeping only those within current window
    const activeTimestamps = timestamps.filter(ts => now - ts < this.windowMs);

    if (activeTimestamps.length >= this.maxRequests) {
      this.clients.set(ip, activeTimestamps);
      return true;
    }

    activeTimestamps.push(now);
    this.clients.set(ip, activeTimestamps);
    return false;
  }
}

const apiRateLimiter = new SlidingWindowLimiter(60000, 60); // 60 Req per Min

function rateLimitMiddleware(req, res, next) {
  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (apiRateLimiter.isRateLimited(clientIp)) {
    console.warn(`[Limiter] IP ${clientIp} was rate-limited.`);
    return res.status(429).json({
      error: 'Too Many Requests',
      message: 'You are sending too many requests. Please slow down and try again in a minute.'
    });
  }
  next();
}

// =========================================================================
// 4. Structured Logger Middleware
// =========================================================================
function structuredLogger(req, res, next) {
  const startTime = process.hrtime.bigint();

  res.on('finish', () => {
    const endTime = process.hrtime.bigint();
    const durationMs = (Number(endTime - startTime) / 1e6).toFixed(3);
    const status = res.statusCode;

    // Terminal colors
    let statusColor = '\x1b[32m'; // green
    if (status >= 400 && status < 500) statusColor = '\x1b[33m'; // yellow
    if (status >= 500) statusColor = '\x1b[31m'; // red
    const resetColor = '\x1b[0m';

    console.log(
      `[API] ${req.method} ${req.originalUrl} - ${statusColor}${status}${resetColor} - ${durationMs}ms - IP: ${req.ip}`
    );
  });

  next();
}

app.use(structuredLogger);

// =========================================================================
// 5. REST APIs
// =========================================================================

// GET /api/categories - get distinct categories
app.get('/api/categories', rateLimitMiddleware, (req, res) => {
  try {
    const stmt = db.prepare('SELECT DISTINCT category FROM products ORDER BY category ASC');
    const categories = stmt.all().map(row => row.category);
    res.json({ categories });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/products - paginated catalogue with cache and cursor security
app.get('/api/products', rateLimitMiddleware, (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const category = req.query.category || null;
    const cursorStr = req.query.cursor || null;

    // 1. Check Query Cache
    const cacheKey = `${category || 'all'}:${cursorStr || 'start'}:${limit}`;
    const cachedResponse = catalogCache.get(cacheKey);
    if (cachedResponse) {
      res.setHeader('X-Cache', 'HIT');
      // Create a shallow copy and tag it as cached for frontend transparency
      const response = { ...cachedResponse };
      response.meta = { ...response.meta, query_duration_ms: 0, cached: true };
      return res.json(response);
    }

    res.setHeader('X-Cache', 'MISS');

    // 2. Decode & Authenticate Cursor
    let cursor = null;
    if (cursorStr) {
      cursor = decodeCursor(cursorStr);
      if (!cursor || typeof cursor.created_at !== 'number' || !cursor.id) {
        return res.status(400).json({ error: 'Invalid or tampered pagination cursor.' });
      }
    }

    let query = '';
    const params = [];
    const selectLimit = limit + 1;

    // Construct query
    if (category) {
      if (cursor) {
        query = `
          SELECT * FROM products
          WHERE category = ? 
            AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `;
        params.push(category, cursor.created_at, cursor.created_at, cursor.id, selectLimit);
      } else {
        query = `
          SELECT * FROM products
          WHERE category = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `;
        params.push(category, selectLimit);
      }
    } else {
      if (cursor) {
        query = `
          SELECT * FROM products
          WHERE (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `;
        params.push(cursor.created_at, cursor.created_at, cursor.id, selectLimit);
      } else {
        query = `
          SELECT * FROM products
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `;
        params.push(selectLimit);
      }
    }

    // Execute query and measure DB latency
    const dbStart = process.hrtime.bigint();
    const stmt = db.prepare(query);
    const rows = stmt.all(...params);
    const dbEnd = process.hrtime.bigint();
    const durationMs = Number(dbEnd - dbStart) / 1e6;

    const hasMore = rows.length > limit;
    const products = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor = null;
    if (hasMore && products.length > 0) {
      const lastProduct = products[products.length - 1];
      nextCursor = encodeCursor(lastProduct.created_at, lastProduct.id);
    }

    const payload = {
      products,
      has_more: hasMore,
      next_cursor: nextCursor,
      meta: {
        query_duration_ms: durationMs,
        limit,
        category,
        cached: false
      }
    };

    // Store in cache
    catalogCache.set(cacheKey, payload);

    res.json(payload);
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /api/products/simulate-activity - simulate concurrent writes & invalidate cache
app.post('/api/products/simulate-activity', rateLimitMiddleware, (req, res) => {
  try {
    const { action } = req.body;
    if (action !== 'insert' && action !== 'update') {
      return res.status(400).json({ error: "Action must be 'insert' or 'update'" });
    }

    // Clear query cache immediately to prevent dirty reads / stale page queries
    catalogCache.clear();

    const count = 50;
    const CATEGORIES = [
      'Electronics', 'Clothing', 'Home & Kitchen', 'Books', 'Sports & Outdoors',
      'Beauty & Personal Care', 'Toys & Games', 'Automotive', 'Garden & Outdoor', 'Tools & Home Improvement'
    ];

    if (action === 'insert') {
      const now = Date.now();
      const insertStmt = db.prepare(`
        INSERT INTO products (id, name, category, price, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const productsAdded = [];
      const runTx = db.transaction(() => {
        for (let i = 0; i < count; i++) {
          const id = `new_prod_${i}_${Math.random().toString(36).substring(2, 7)}`;
          const name = `Simulated New Product #${i + 1}`;
          const category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
          const price = Math.round((Math.random() * 14500 + 499) * 100) / 100; // ₹499 to ₹15,000
          const createdAt = now + i * 1000;
          const updatedAt = createdAt;

          insertStmt.run(id, name, category, price, createdAt, updatedAt);
          productsAdded.push({ id, name, category, price, created_at: createdAt, updated_at: updatedAt });
        }
      });

      runTx();
      return res.json({ message: 'Successfully added 50 new products.', products: productsAdded });
    } else {
      const getRandomProducts = db.prepare('SELECT id, name, created_at FROM products ORDER BY RANDOM() LIMIT ?');
      const updateProduct = db.prepare('UPDATE products SET name = ?, price = ?, updated_at = ? WHERE id = ?');

      const productsUpdated = [];
      const runTx = db.transaction(() => {
        const selected = getRandomProducts.all(count);
        const now = Date.now();
        for (const prod of selected) {
          const newName = `[UPDATED] ${prod.name}`;
          const newPrice = Math.round((Math.random() * 14500 + 499) * 100) / 100; // ₹499 to ₹15,000
          updateProduct.run(newName, newPrice, now, prod.id);
          productsUpdated.push({ id: prod.id, name: newName, price: newPrice, created_at: prod.created_at, updated_at: now });
        }
      });

      runTx();
      return res.json({ message: 'Successfully updated 50 random products.', products: productsUpdated });
    }
  } catch (error) {
    console.error('Error simulating activity:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// =========================================================================
// 6. Server Initialization & Graceful Shutdown
// =========================================================================
function startServer(port) {
  const server = app.listen(port);

  server.on('listening', () => {
    console.log(`Product catalog server running at http://localhost:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} is in use, trying ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Server error:', err);
    }
  });
}

startServer(PORT);

// Clean closing of database connection on termination signals
function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] Received ${signal}. Starting graceful termination...`);
  try {
    db.close();
    console.log('[Shutdown] SQLite database connection closed cleanly.');
  } catch (err) {
    console.error('[Shutdown] Error closing database connection:', err);
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
