import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, 'products.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// Clean up existing DB for clean run
if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
  console.log('Existing database deleted.');
}

const db = new Database(DB_PATH);

console.log('Initializing schema...');
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);
console.log('Schema initialized successfully.');

// Config for generation
const TOTAL_PRODUCTS = 200000;
const CATEGORIES = [
  'Electronics',
  'Clothing',
  'Home & Kitchen',
  'Books',
  'Sports & Outdoors',
  'Beauty & Personal Care',
  'Toys & Games',
  'Automotive',
  'Garden & Outdoor',
  'Tools & Home Improvement'
];

const ADJECTIVES = ['Premium', 'Wireless', 'Eco-friendly', 'Ergonomic', 'Portable', 'Sleek', 'Smart', 'Compact', 'Durable', 'Classic'];
const MATERIALS = ['Wooden', 'Leather', 'Metal', 'Plastic', 'Glass', 'Ceramic', 'Carbon Fiber', 'Bamboo', 'Steel', 'Silicone'];
const NOUNS = ['Headphones', 'Chair', 'Keyboard', 'Water Bottle', 'Backpack', 'Lamp', 'Watch', 'Notebook', 'Speaker', 'Phone Stand'];

function getRandomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateProductName(index) {
  const adj = getRandomItem(ADJECTIVES);
  const mat = getRandomItem(MATERIALS);
  const noun = getRandomItem(NOUNS);
  return `${adj} ${mat} ${noun} #${index}`;
}

console.log(`Generating and inserting ${TOTAL_PRODUCTS} products...`);
const startTime = Date.now();

// Prepare insert statement
const insertStmt = db.prepare(`
  INSERT INTO products (id, name, category, price, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// Execute everything within a single transaction for maximum speed
const seedTransaction = db.transaction(() => {
  let now = Date.now();
  for (let i = 0; i < TOTAL_PRODUCTS; i++) {
    // Generate UUID v4 format or unique string
    // Standard Node.js crypto.randomUUID() could be a bit slow in a tight loop of 200,000,
    // so we can build a simple high-performance unique ID or use built-in.
    // Let's use a simple fast unique string generator: 'prod_' + i + '_' + random_suffix
    const id = `prod_${i}_${Math.random().toString(36).substring(2, 7)}`;
    const name = generateProductName(i);
    const category = getRandomItem(CATEGORIES);
    const price = Math.round((Math.random() * 79700 + 299) * 100) / 100; // ₹299.00 to ₹80,000.00
    
    // Decrement created_at to simulate historical records (newest first browsing)
    const createdAt = now - i * 10000 - Math.floor(Math.random() * 5000); 
    // updated_at is sometimes newer than created_at
    const updatedAt = createdAt + (Math.random() > 0.8 ? Math.floor(Math.random() * 86400000) : 0);

    insertStmt.run(id, name, category, price, createdAt, updatedAt);
  }
});

// Run the transaction
seedTransaction();

const endTime = Date.now();
const durationSeconds = ((endTime - startTime) / 1000).toFixed(2);
console.log(`Successfully seeded ${TOTAL_PRODUCTS} products in ${durationSeconds} seconds!`);

// Verify counts
const count = db.prepare('SELECT COUNT(*) AS total FROM products').get().total;
console.log(`Verification: Total rows in database = ${count}`);

// Close db
db.close();
