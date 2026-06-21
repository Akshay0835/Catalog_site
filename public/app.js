// Application state
let currentPageIndex = 0;
const cursorHistory = [null]; // History of cursors. Page 0 starts with null.
let nextPageCursor = null;
const loadedProductIds = new Set();
let currentCategory = '';

// Currency formatter for INR
const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2
});

// DOM Elements
const categorySelect = document.getElementById('category-select');
const btnRefresh = document.getElementById('btn-refresh');
const btnSimulateInsert = document.getElementById('btn-simulate-insert');
const btnSimulateUpdate = document.getElementById('btn-simulate-update');
const activityLog = document.getElementById('activity-log');
const productsGrid = document.getElementById('products-grid');
const loadedCountText = document.getElementById('loaded-count');
const perfMetrics = document.getElementById('perf-metrics');
const duplicateWarning = document.getElementById('duplicate-warning');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const pageIndicator = document.getElementById('page-indicator');
const endOfCatalogText = document.getElementById('end-of-catalog');
const loadingSpinner = document.getElementById('loading-spinner');

// Initialize app
window.addEventListener('DOMContentLoaded', () => {
  fetchCategories();
  loadCatalog(); // Initial load
});

// Event Listeners
categorySelect.addEventListener('change', (e) => {
  currentCategory = e.target.value;
  resetPagination();
  loadCatalog();
});

btnRefresh.addEventListener('click', () => {
  resetPagination();
  loadCatalog();
  addLog('Catalog refreshed and reset to Page 1.', 'system');
});

btnPrev.addEventListener('click', () => {
  if (currentPageIndex > 0) {
    currentPageIndex--;
    loadCatalog();
  }
});

btnNext.addEventListener('click', () => {
  if (nextPageCursor) {
    currentPageIndex++;
    // If we haven't visited this page index yet, store its cursor
    if (currentPageIndex >= cursorHistory.length) {
      cursorHistory.push(nextPageCursor);
    }
    loadCatalog();
  }
});

btnSimulateInsert.addEventListener('click', async () => {
  try {
    btnSimulateInsert.disabled = true;
    const res = await fetch('/api/products/simulate-activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'insert' })
    });
    const data = await res.json();
    addLog(`Inserted 50 products! E.g.: "${data.products[0].name}"`, 'insert');
  } catch (err) {
    addLog(`Simulation error: ${err.message}`, 'error');
  } finally {
    btnSimulateInsert.disabled = false;
  }
});

btnSimulateUpdate.addEventListener('click', async () => {
  try {
    btnSimulateUpdate.disabled = true;
    const res = await fetch('/api/products/simulate-activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update' })
    });
    const data = await res.json();
    addLog(`Updated 50 products! E.g.: "${data.products[0].name}"`, 'update');
    
    // Highlight any updated products currently displayed in the DOM
    data.products.forEach(p => {
      const card = document.getElementById(`card-${p.id}`);
      if (card) {
        card.classList.add('simulated-updated');
        card.querySelector('.product-title').innerText = p.name;
        card.querySelector('.product-price').innerText = inrFormatter.format(p.price);
        card.querySelector('.product-updated-at').innerText = `Updated: ${new Date(p.updated_at).toLocaleTimeString()}`;
        
        // Remove highlight class after animation finishes
        setTimeout(() => {
          card.classList.remove('simulated-updated');
        }, 1200);
      }
    });
  } catch (err) {
    addLog(`Simulation error: ${err.message}`, 'error');
  } finally {
    btnSimulateUpdate.disabled = false;
  }
});

// Helper to reset pagination state
function resetPagination() {
  currentPageIndex = 0;
  cursorHistory.length = 0;
  cursorHistory.push(null);
  nextPageCursor = null;
}

// Logger helper
function addLog(message, type = 'system') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const timestamp = new Date().toLocaleTimeString();
  entry.innerText = `[${timestamp}] ${message}`;
  activityLog.appendChild(entry);
  activityLog.scrollTop = activityLog.scrollHeight;
}

// Fetch categories for filter dropdown
async function fetchCategories() {
  try {
    const res = await fetch('/api/categories');
    const data = await res.json();
    data.categories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.innerText = cat;
      categorySelect.appendChild(opt);
    });
  } catch (err) {
    console.error('Error fetching categories:', err);
    addLog('Error fetching categories.', 'error');
  }
}

// Load products catalog page
async function loadCatalog() {
  try {
    // Reset view
    loadedProductIds.clear();
    productsGrid.innerHTML = '';
    duplicateWarning.classList.add('hidden');

    // Toggle controls
    btnPrev.disabled = true;
    btnNext.disabled = true;
    endOfCatalogText.classList.add('hidden');
    loadingSpinner.classList.remove('hidden');

    // Get current cursor
    const cursor = cursorHistory[currentPageIndex];

    // Build URL
    let url = `/api/products?limit=24`;
    if (currentCategory) {
      url += `&category=${encodeURIComponent(currentCategory)}`;
    }
    if (cursor) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    const data = await res.json();

    loadingSpinner.classList.add('hidden');
    
    // Update page title
    pageIndicator.innerText = `Page ${currentPageIndex + 1}`;

    if (data.products.length === 0) {
      productsGrid.innerHTML = '<p class="end-catalog-text">No products found.</p>';
      loadedCountText.innerText = 'Loaded: 0 products';
      perfMetrics.innerText = `Query time: ${data.meta.query_duration_ms.toFixed(2)} ms`;
      return;
    }

    // Render cards
    data.products.forEach(p => {
      // Consistency check: Check for duplicates within the same loaded page
      if (loadedProductIds.has(p.id)) {
        console.warn(`Duplicate ID detected: ${p.id}`);
        duplicateWarning.classList.remove('hidden');
        addLog(`WARNING: Duplicate product ID loaded: ${p.id}!`, 'error');
      }
      loadedProductIds.add(p.id);

      const card = document.createElement('div');
      card.className = 'product-card';
      if (p.id.startsWith('new_prod_')) {
        card.classList.add('simulated-new');
      }
      card.id = `card-${p.id}`;

      const createdTime = new Date(p.created_at).toLocaleTimeString();
      const updatedTime = new Date(p.updated_at).toLocaleTimeString();

      card.innerHTML = `
        <span class="product-category">${p.category}</span>
        <h3 class="product-title" title="${p.name}">${p.name}</h3>
        <div class="product-price">${inrFormatter.format(p.price)}</div>
        <div class="product-footer">
          <span class="product-id">ID: ${p.id}</span>
          <span>Created: ${createdTime}</span>
          <span class="product-updated-at">Updated: ${updatedTime}</span>
        </div>
      `;
      productsGrid.appendChild(card);
    });

    // Update stats
    const startRange = currentPageIndex * 24 + 1;
    const endRange = currentPageIndex * 24 + data.products.length;
    loadedCountText.innerText = `Showing items ${startRange.toLocaleString()} - ${endRange.toLocaleString()}`;
    perfMetrics.innerText = `Query time: ${data.meta.query_duration_ms.toFixed(2)} ms`;

    // Save next cursor
    nextPageCursor = data.next_cursor;

    // Toggle navigation buttons
    btnPrev.disabled = currentPageIndex === 0;
    btnNext.disabled = !data.has_more;

    if (!data.has_more) {
      endOfCatalogText.classList.remove('hidden');
    }

    addLog(`Fetched Page ${currentPageIndex + 1} with ${data.products.length} products. (Time: ${data.meta.query_duration_ms.toFixed(2)}ms)`, 'system');

  } catch (err) {
    loadingSpinner.classList.add('hidden');
    addLog(`Fetch error: ${err.message}`, 'error');
    console.error(err);
  }
}
