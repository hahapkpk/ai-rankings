/**
 * AI Rankings Data Fetcher v2
 * 
 * Uses Puppeteer to scrape rendered data from 4 sources.
 * Strategy: extract rendered HTML from tables, save as JSON.
 * The build script then injects into the page template.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const SNAPSHOT_FILE = path.join(OUT_DIR, 'latest-snapshot.json');

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  });
  await new Promise(r => setTimeout(r, 1500));
}

// ============================================================
// 1. OpenRouter Rankings - Extract from rendered DOM
// ============================================================
async function fetchOpenRouter(page) {
  console.log('📊 Fetching OpenRouter Rankings...');
  
  const result = {
    leaderboard: {},
    fetchedAt: new Date().toISOString()
  };
  
  // Try fetching weekly leaderboard
  const periods = [
    { key: 'week', url: 'https://openrouter.ai/rankings?view=week' },
    { key: 'today', url: 'https://openrouter.ai/rankings?view=day' },
    { key: 'month', url: 'https://openrouter.ai/rankings?view=month' },
    { key: 'trending', url: 'https://openrouter.ai/rankings?view=trending' }
  ];
  
  for (const period of periods) {
    try {
      console.log(`  Fetching ${period.key}...`);
      await page.goto(period.url, { waitUntil: 'networkidle2', timeout: 30000 });
      await autoScroll(page);
      
      const rows = await page.evaluate(() => {
        const results = [];
        // Try multiple selector strategies
        const selectors = [
          'table tbody tr',
          '[class*="rankings"] tr',
          '[class*="leaderboard"] tr',
          'a[href*="/models/"]'
        ];
        
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          if (els.length > 3) {
            els.forEach(el => {
              if (sel.includes('a[href')) {
                // Extract from link elements
                const row = el.closest('tr') || el.closest('[class*="row"]');
                if (row) {
                  const cells = row.querySelectorAll('td, [class*="cell"]');
                  if (cells.length >= 3) {
                    results.push(Array.from(cells).map(c => c.textContent.trim()));
                  }
                }
              } else {
                const cells = el.querySelectorAll('td');
                if (cells.length >= 3) {
                  results.push(Array.from(cells).map(c => c.textContent.trim()));
                }
              }
            });
            break;
          }
        }
        return results;
      });
      
      result.leaderboard[period.key] = rows;
      console.log(`  ✓ ${period.key}: ${rows.length} models`);
    } catch (e) {
      console.warn(`  ✗ ${period.key}: ${e.message}`);
      result.leaderboard[period.key] = [];
    }
  }
  
  return result;
}

// ============================================================
// 2. Vals AI SWE-bench - Extract from rendered DOM
// ============================================================
async function fetchValsAI(page) {
  console.log('🧪 Fetching Vals AI...');
  const url = 'https://www.vals.ai/benchmarks/swebench';
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await autoScroll(page);
  
  const data = await page.evaluate(() => {
    const results = [];
    const table = document.querySelector('table');
    if (table) {
      const thead = table.querySelector('thead tr');
      const headers = thead ? Array.from(thead.querySelectorAll('th')).map(th => th.textContent.trim()) : [];
      
      table.querySelectorAll('tbody tr').forEach(tr => {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
        if (cells.length > 0) {
          results.push({ headers, cells });
        }
      });
    }
    return { swebench: results, fetchedAt: new Date().toISOString() };
  });
  
  console.log(`  ✓ SWE-bench: ${data.swebench.length} entries`);
  return data;
}

// ============================================================
// 3. Arena AI Leaderboard - Extract from rendered DOM
// ============================================================
async function fetchArenaAI(page) {
  console.log('⚔️ Fetching Arena AI...');
  const url = 'https://lmarena.ai/leaderboard/text';
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  
  // Wait for table to appear
  try {
    await page.waitForSelector('table', { timeout: 20000 });
  } catch (e) {
    console.warn('  Warning: table not found in time');
  }
  await autoScroll(page);
  
  const data = await page.evaluate(() => {
    const results = [];
    const tables = document.querySelectorAll('table');
    
    for (const table of tables) {
      const thead = table.querySelector('thead tr');
      const headers = thead ? Array.from(thead.querySelectorAll('th')).map(th => th.textContent.trim()) : [];
      
      const rows = [];
      table.querySelectorAll('tbody tr').forEach(tr => {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
        if (cells.length > 0) rows.push(cells);
      });
      
      if (rows.length > results.length) {
        results.length = 0;
        results.push(...rows.map(r => ({ headers, cells: r })));
      }
    }
    
    return { textLeaderboard: results, fetchedAt: new Date().toISOString() };
  });
  
  console.log(`  ✓ Arena: ${data.textLeaderboard.length} models`);
  return data;
}

// ============================================================
// 4. TERMS-Bench - Extract from rendered DOM
// ============================================================
async function fetchTermsBench(page) {
  console.log('🤝 Fetching TERMS-Bench...');
  
  const result = {
    main: {},
    fetchedAt: new Date().toISOString()
  };
  
  const regimes = [
    { key: 'overall', param: 'overall' },
    { key: 'overlap', param: 'overlap' },
    { key: 'urgency', param: 'urgency_shift' },
    { key: 'nodeal', param: 'no_deal' }
  ];
  
  for (const regime of regimes) {
    try {
      console.log(`  Fetching regime: ${regime.key}...`);
      const url = `https://terms-bench.github.io/?theme=light&regime=${regime.param}`;
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      
      try {
        await page.waitForSelector('table', { timeout: 15000 });
      } catch (e) {}
      await new Promise(r => setTimeout(r, 2000));
      
      const data = await page.evaluate(() => {
        const table = document.querySelector('table');
        if (!table) return [];
        const rows = [];
        table.querySelectorAll('tbody tr').forEach(tr => {
          const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
          if (cells.length > 0) rows.push(cells);
        });
        return rows;
      });
      
      result.main[regime.key] = data;
      console.log(`  ✓ ${regime.key}: ${data.length} agents`);
    } catch (e) {
      console.warn(`  ✗ ${regime.key}: ${e.message}`);
      result.main[regime.key] = [];
    }
  }
  
  return result;
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log('🚀 Starting AI Rankings data fetch v2...\n');
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080'
    ]
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  const snapshot = {
    version: '2.0',
    fetchedAt: new Date().toISOString(),
    sources: {}
  };
  
  const fetchers = [
    { name: 'openrouter', fn: fetchOpenRouter },
    { name: 'valsai', fn: fetchValsAI },
    { name: 'arena', fn: fetchArenaAI },
    { name: 'terms', fn: fetchTermsBench }
  ];
  
  for (const { name, fn } of fetchers) {
    try {
      snapshot.sources[name] = await fn(page);
    } catch (e) {
      console.error(`  ✗ Failed to fetch ${name}: ${e.message}`);
      snapshot.sources[name] = { error: e.message, fetchedAt: new Date().toISOString() };
    }
  }
  
  await browser.close();
  
  // Save snapshot
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
  console.log(`\n✅ Snapshot saved: ${(fs.statSync(SNAPSHOT_FILE).size / 1024).toFixed(1)} KB`);
  
  // Save metadata
  const meta = {
    lastUpdated: snapshot.fetchedAt,
    sources: {}
  };
  for (const k of Object.keys(snapshot.sources)) {
    const s = snapshot.sources[k];
    meta.sources[k] = {
      status: s.error ? 'error' : 'ok',
      itemCount: s.leaderboard?.week?.length || s.swebench?.length || s.textLeaderboard?.length || s.main?.overall?.length || 0
    };
  }
  fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
