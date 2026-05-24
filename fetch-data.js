/**
 * AI Rankings Data Fetcher v3
 * 
 * Strategy overhaul:
 * - OpenRouter: Use Puppeteer to scrape the rendered rankings page.
 *   The rankings page uses Next.js RSC, so we scrape the rendered DOM.
 *   Multiple strategies: intercept RSC network response + extract rendered DOM.
 * - Vals AI: Improved Puppeteer scraping with longer waits
 * - Arena AI: Keep working Puppeteer scraping
 * - TERMS-Bench: Keep working Puppeteer scraping
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
// 1. OpenRouter Rankings - Scrape rendered DOM + intercept RSC
// ============================================================
async function fetchOpenRouter(page) {
  console.log('📊 Fetching OpenRouter Rankings...');
  
  const result = {
    leaderboard: {},
    topModels: [],
    fetchedAt: new Date().toISOString()
  };
  
  const periods = [
    { key: 'week', url: 'https://openrouter.ai/rankings?view=week' },
    { key: 'today', url: 'https://openrouter.ai/rankings?view=day' },
    { key: 'month', url: 'https://openrouter.ai/rankings?view=month' },
    { key: 'trending', url: 'https://openrouter.ai/rankings?view=trending' }
  ];
  
  for (const period of periods) {
    try {
      console.log(`  Fetching ${period.key} from ${period.url}...`);
      
      // Set up RSC response interception
      let rscData = null;
      const interceptHandler = async (response) => {
        const url = response.url();
        if (url.includes('/rankings') && response.request().method() === 'POST') {
          try {
            const contentType = response.headers()['content-type'] || '';
            if (contentType.includes('text')) {
              const text = await response.text();
              // RSC responses may contain data in a structured format
              // Try to extract model data from the response
              if (text && text.length > 100) {
                rscData = text;
              }
            }
          } catch (e) {
            // Ignore interception errors
          }
        }
      };
      page.on('response', interceptHandler);
      
      await page.goto(period.url, { waitUntil: 'networkidle2', timeout: 45000 });
      
      // Wait for content to render
      await new Promise(r => setTimeout(r, 5000));
      await autoScroll(page);
      await new Promise(r => setTimeout(r, 3000));
      
      // Remove the handler
      page.off('response', interceptHandler);
      
      // Extract data from the rendered DOM
      const domData = await page.evaluate(() => {
        const results = [];
        
        // Strategy 1: Look for any table-like structure
        const tables = document.querySelectorAll('table');
        if (tables.length > 0) {
          for (const table of tables) {
            const rows = table.querySelectorAll('tbody tr');
            rows.forEach(tr => {
              const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
              if (cells.length >= 2) results.push(cells);
            });
          }
          if (results.length > 0) return { rows: results, method: 'table' };
        }
        
        // Strategy 2: Look for grid/flex layout with model cards/rows
        // Next.js apps often use div-based layouts
        const potentialRows = document.querySelectorAll(
          '[class*="leaderboard"] [class*="row"], ' +
          '[class*="rankings"] [class*="row"], ' +
          '[class*="model-row"], ' +
          '[class*="ModelRow"], ' +
          '[class*="table-row"], ' +
          'a[href*="/models/"]'
        );
        if (potentialRows.length > 3) {
          const items = [];
          potentialRows.forEach(el => {
            const text = el.textContent.trim();
            const href = el.getAttribute('href') || '';
            if (text && text.length > 3 && text.length < 500) {
              items.push({ text, href, tag: el.tagName, className: el.className });
            }
          });
          if (items.length > 0) return { rows: items, method: 'class-selector' };
        }
        
        // Strategy 3: Find all links to model pages and their parent containers
        const modelLinks = document.querySelectorAll('a[href*="/models/"]');
        if (modelLinks.length > 3) {
          const models = [];
          modelLinks.forEach(link => {
            const row = link.closest('div[class]') || link.closest('tr') || link.parentElement;
            if (row) {
              const text = row.textContent.trim();
              const href = link.getAttribute('href');
              const modelName = link.textContent.trim();
              if (modelName && text) {
                models.push({ 
                  name: modelName, 
                  href,
                  rowText: text.substring(0, 200),
                  parentTag: row.tagName,
                  parentClass: row.className
                });
              }
            }
          });
          if (models.length > 0) return { rows: models, method: 'model-links' };
        }
        
        // Strategy 4: Dump significant text blocks for debugging
        const allDivs = document.querySelectorAll('div');
        const textBlocks = [];
        allDivs.forEach(div => {
          if (div.children.length === 0 || div.children.length <= 3) {
            const text = div.textContent.trim();
            if (text && text.length > 10 && text.length < 200 && 
                (text.includes('%') || text.match(/\d{2,}/))) {
              textBlocks.push({ text, class: div.className, tag: div.tagName });
            }
          }
        });
        
        return { 
          rows: [], 
          method: 'none',
          debug: {
            tableCount: document.querySelectorAll('table').length,
            linkCount: document.querySelectorAll('a[href*="/models/"]').length,
            bodyLength: document.body.innerText.length,
            sampleText: document.body.innerText.substring(0, 3000),
            textBlocks: textBlocks.slice(0, 30)
          }
        };
      });
      
      if (domData.rows && domData.rows.length > 0) {
        result.leaderboard[period.key] = domData.rows;
        console.log(`  ✓ ${period.key}: ${domData.rows.length} models (method: ${domData.method})`);
      } else {
        result.leaderboard[period.key] = [];
        // Save debug info for the first period only
        if (period.key === 'week' && domData.debug) {
          result.debug = domData.debug;
          console.log(`  ⚠ ${period.key}: 0 models found`);
          console.log(`    Tables: ${domData.debug.tableCount}, Model links: ${domData.debug.linkCount}`);
          console.log(`    Body length: ${domData.debug.bodyLength}`);
          // Log first few text blocks for diagnosis
          if (domData.debug.sampleText) {
            const lines = domData.debug.sampleText.split('\n').filter(l => l.trim()).slice(0, 20);
            console.log(`    Sample text (first 20 lines):`);
            lines.forEach(l => console.log(`      ${l.substring(0, 100)}`));
          }
        } else {
          console.log(`  ⚠ ${period.key}: 0 models found`);
        }
      }
      
    } catch (e) {
      console.warn(`  ✗ ${period.key}: ${e.message}`);
      result.leaderboard[period.key] = [];
    }
  }
  
  return result;
}

// ============================================================
// 2. Vals AI SWE-bench - Improved Puppeteer scraping
// ============================================================
async function fetchValsAI(page) {
  console.log('🧪 Fetching Vals AI...');
  const url = 'https://www.vals.ai/benchmarks/swebench';
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    
    // Wait longer for dynamic content to render
    await new Promise(r => setTimeout(r, 5000));
    
    // Try to wait for table or data to appear
    try {
      await page.waitForSelector('table, [class*="table"], [class*="benchmark"]', { timeout: 15000 });
    } catch (e) {
      console.log('  ⚠ Standard table selector not found, trying alternative approach...');
    }
    
    await autoScroll(page);
    await new Promise(r => setTimeout(r, 3000));
    
    const data = await page.evaluate(() => {
      const results = [];
      
      // Strategy 1: Standard HTML table
      const tables = document.querySelectorAll('table');
      if (tables.length > 0) {
        for (const table of tables) {
          const thead = table.querySelector('thead tr') || table.querySelector('tr');
          const headers = thead ? Array.from(thead.querySelectorAll('th, td')).map(th => th.textContent.trim()) : [];
          
          const rows = [];
          table.querySelectorAll('tbody tr').forEach(tr => {
            const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
            if (cells.length > 0) rows.push({ headers, cells });
          });
          
          if (rows.length > results.length) {
            results.length = 0;
            results.push(...rows);
          }
        }
        if (results.length > 0) return { swebench: results, method: 'table', fetchedAt: new Date().toISOString() };
      }
      
      // Strategy 2: Look for percentage patterns (e.g., "82.60%")
      const allText = document.body.innerText;
      const percentMatches = allText.match(/[\w\s\-.]+\s+\d+\.\d+%/g);
      if (percentMatches && percentMatches.length > 3) {
        return { swebench: percentMatches.slice(0, 30), method: 'regex-percent', fetchedAt: new Date().toISOString() };
      }
      
      // Strategy 3: Dump sample text for debugging
      return { 
        swebench: [], 
        method: 'none',
        debug: {
          tableCount: document.querySelectorAll('table').length,
          bodyLength: allText.length,
          sampleText: allText.substring(0, 2000)
        },
        fetchedAt: new Date().toISOString() 
      };
    });
    
    const count = Array.isArray(data.swebench) ? data.swebench.length : 0;
    console.log(`  ✓ Vals AI: ${count} entries (method: ${data.method || 'unknown'})`);
    
    if (count === 0 && data.debug) {
      console.log(`    Tables: ${data.debug.tableCount}, Body: ${data.debug.bodyLength} chars`);
    }
    
    return data;
    
  } catch (e) {
    console.warn(`  ✗ Vals AI failed: ${e.message}`);
    return { swebench: [], error: e.message, fetchedAt: new Date().toISOString() };
  }
}

// ============================================================
// 3. Arena AI Leaderboard - Working Puppeteer scraping
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
// 4. TERMS-Bench - Working Puppeteer scraping
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
  console.log('🚀 Starting AI Rankings data fetch v3...\n');
  
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
    version: '3.0',
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
  
  // Save snapshot (truncate debug info to keep file size reasonable)
  const snapshotForFile = { ...snapshot };
  if (snapshotForFile.sources.openrouter?.debug) {
    // Keep debug but truncate sampleText
    if (snapshotForFile.sources.openrouter.debug.sampleText) {
      snapshotForFile.sources.openrouter.debug.sampleText = 
        snapshotForFile.sources.openrouter.debug.sampleText.substring(0, 2000);
    }
    if (snapshotForFile.sources.openrouter.debug.textBlocks) {
      snapshotForFile.sources.openrouter.debug.textBlocks = 
        snapshotForFile.sources.openrouter.debug.textBlocks.slice(0, 20);
    }
  }
  if (snapshotForFile.sources.valsai?.debug) {
    if (snapshotForFile.sources.valsai.debug.sampleText) {
      snapshotForFile.sources.valsai.debug.sampleText = 
        snapshotForFile.sources.valsai.debug.sampleText.substring(0, 2000);
    }
  }
  
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshotForFile, null, 2));
  console.log(`\n✅ Snapshot saved: ${(fs.statSync(SNAPSHOT_FILE).size / 1024).toFixed(1)} KB`);
  
  // Save metadata
  const meta = {
    lastUpdated: snapshot.fetchedAt,
    sources: {}
  };
  for (const k of Object.keys(snapshot.sources)) {
    const s = snapshot.sources[k];
    let count = 0;
    if (s.leaderboard) {
      // Sum all periods
      count = Object.values(s.leaderboard).reduce((sum, arr) => sum + (arr?.length || 0), 0);
    } else if (Array.isArray(s.swebench)) {
      count = s.swebench.length;
    } else if (s.textLeaderboard) {
      count = s.textLeaderboard.length;
    } else if (s.main) {
      count = s.main.overall?.length || 0;
    }
    meta.sources[k] = {
      status: s.error ? 'error' : 'ok',
      itemCount: count
    };
  }
  fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
  
  console.log('\n📊 Data Summary:');
  for (const [k, v] of Object.entries(meta.sources)) {
    console.log(`  ${k}: ${v.status} (${v.itemCount} items)`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
