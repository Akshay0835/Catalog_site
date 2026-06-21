import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVER_PATH = path.join(__dirname, '../server/index.js');
const TEST_PORT = 4000;

console.log('--- Launching server in test mode... ---');
const serverProcess = spawn('node', [SERVER_PATH], {
  env: { ...process.env, PORT: TEST_PORT },
  stdio: ['pipe', 'pipe', 'inherit'] // pipe stdout, forward stderr
});

let serverOutput = '';
serverProcess.stdout.on('data', (data) => {
  const text = data.toString();
  serverOutput += text;
  process.stdout.write('[Server Output] ' + text);
});

// Helper to make request
function makeRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: JSON.parse(data)
        });
      });
    });

    req.on('error', (err) => reject(err));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Wait for server to start
setTimeout(async () => {
  try {
    console.log('\n--- 1. Testing Cache Miss ---');
    const res1 = await makeRequest('/api/products?limit=5');
    console.log(`Status: ${res1.status}`);
    console.log(`Cache Header (Expected MISS): ${res1.headers['x-cache']}`);
    console.log(`Payload products length: ${res1.body.products.length}`);
    const cursor = res1.body.next_cursor;
    console.log(`Returned Cursor (Signed): ${cursor}`);

    console.log('\n--- 2. Testing Cache Hit ---');
    const res2 = await makeRequest('/api/products?limit=5');
    console.log(`Status: ${res2.status}`);
    console.log(`Cache Header (Expected HIT): ${res2.headers['x-cache']}`);
    console.log(`Payload cached meta details:`, res2.body.meta);

    console.log('\n--- 3. Testing Cache Invalidation via Simulator Write ---');
    const resInvalidate = await makeRequest('/api/products/simulate-activity', 'POST', { action: 'insert' });
    console.log(`Simulation Status: ${resInvalidate.status}`);
    console.log(`Simulation Response:`, resInvalidate.body.message);

    console.log('\n--- 4. Testing Post-Invalidation Query (Expected MISS) ---');
    const res3 = await makeRequest('/api/products?limit=5');
    console.log(`Status: ${res3.status}`);
    console.log(`Cache Header (Expected MISS): ${res3.headers['x-cache']}`);

    console.log('\n--- 5. Testing Cryptographic Cursor Security (Tampered Signature) ---');
    const tamperedCursor = cursor.substring(0, cursor.length - 8) + 'invalidX';
    const resTampered = await makeRequest(`/api/products?limit=5&cursor=${tamperedCursor}`);
    console.log(`Status (Expected 400): ${resTampered.status}`);
    console.log(`Body:`, resTampered.body);

    console.log('\n--- 6. Testing Rate Limiting (65 requests in rapid sequence) ---');
    console.log('Sending requests...');
    let lastStatus = 0;
    let hitRateLimit = false;
    for (let i = 0; i < 65; i++) {
      const res = await makeRequest('/api/products?limit=1');
      lastStatus = res.status;
      if (res.status === 429) {
        hitRateLimit = true;
        console.log(`Received 429 Too Many Requests at request #${i + 1}`);
        console.log(`Limit Message:`, res.body.message);
        break;
      }
    }
    if (!hitRateLimit) {
      console.log(`Finished 65 requests. Last status code was ${lastStatus} (Expected 429)`);
    }

    console.log('\n--- 7. Terminating server and checking Graceful Shutdown ---');
    serverProcess.kill('SIGINT');

    setTimeout(() => {
      console.log('\n--- Verification Finished. Exiting. ---');
      process.exit(0);
    }, 1000);

  } catch (err) {
    console.error('Test script encountered error:', err);
    serverProcess.kill('SIGINT');
    process.exit(1);
  }
}, 2000);
