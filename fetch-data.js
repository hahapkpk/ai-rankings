/**
 * AI Rankings Data Fetcher
 * 
 * Uses Puppeteer to scrape data from 4 sources:
 * 1. OpenRouter Rankings (https://openrouter.ai/rankings)
 * 2. Vals AI SWE-bench (https://www.vals.ai/benchmarks/swebench)
 * 3. Arena AI Leaderboard (https://lmarena.ai/leaderboard/text)
 * 4. TERMS-Bench (https://terms-bench.github.io)
 * 
 * Outputs: data/latest-snapshot.json
 * 
 * Usage: node fetch-data.js
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
      const distance = 300;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
  await new Promise(r => setTimeout(r, 1000));
}

async function waitForContent(page, selector, timeout = 15000) {
  try {
    await page.waitForSelector(selector, { timeout });
    await new Promise(r => setTimeout(r, 2000));
  } catch (e) {
    console.warn(`  Warning: selector ${selector} not found within timeout`);
  }
}

// ============================================================
// 1. OpenRouter Rankings
// ============================================================
async function fetchOpenRouter(page) {
  console.log('📊 Fetching OpenRouter Rankings...');
  const url = 'https://openrouter.ai/rankings';
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await autoScroll(page);
  
  const data = await page.evaluate(() => {
    const result = {
      leaderboard: { today: [], week: [], month: [], trending: [] },
      marketShare: [],
      categories: {},
      apps: { today: [], week: [], month: [] },
      benchmarks: [],
      fastest: [],
      fetchedAt: new Date().toISOString()
    };
    
    // Leaderboard tables
    const periods = ['today', 'week', 'month', 'trending'];
    periods.forEach(p => {
      const table = document.querySelector(`[data-period="${p}"] tbody`) || 
                    document.querySelector(`.period-table[data-period="${p}"] tbody`);
      if (table) {
        table.querySelectorAll('tr').forEach(tr => {
          const cells = tr.querySelectorAll('td');
          if (cells.length >= 4) {
            result.leaderboard[p].push({
              rank: cells[0]?.textContent.trim(),
              model: cells[1]?.textContent.trim(),
              provider: cells[2]?.textContent.trim(),
              tokens: cells[3]?.textContent.trim(),
              change: cells[4]?.textContent.trim()
            });
          }
        });
      }
    });
    
    // If period-specific tables not found, try main table
    if (result.leaderboard.week.length === 0) {
      const mainTable = document.querySelector('table tbody');
      if (mainTable) {
        mainTable.querySelectorAll('tr').forEach(tr => {
          const cells = tr.querySelectorAll('td');
          if (cells.length >= 4) {
            result.leaderboard.week.push({
              rank: cells[0]?.textContent.trim(),
              model: cells[1]?.textContent.trim(),
              provider: cells[2]?.textContent.trim(),
              tokens: cells[3]?.textContent.trim(),
              change: cells[4]?.textContent.trim()
            });
          }
        });
      }
    }
    
    return result;
  });
  
  console.log(`  ✓ Leaderboard: ${data.leaderboard.week.length} models`);
  return data;
}

// ============================================================
// 2. Vals AI SWE-bench
// ============================================================
async function fetchValsAI(page) {
  console.log('🧪 Fetching Vals AI...');
  const url = 'https://www.vals.ai/benchmarks/swebench';
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await autoScroll(page);
  
  const data = await page.evaluate(() => {
    const result = {
      swebench: [],
      benchmarks: [],
      fetchedAt: new Date().toISOString()
    };
    
    // SWE-bench table
    const table = document.querySelector('table tbody');
    if (table) {
      table.querySelectorAll('tr').forEach(tr => {
        const cells = tr.querySelectorAll('td');
        if (cells.length >= 2) {
          const row = {};
          cells.forEach((cell, i) => {
            row[`col${i}`] = cell.textContent.trim();
          });
          result.swebench.push(row);
        }
      });
    }
    
    return result;
  });
  
  console.log(`  ✓ SWE-bench: ${data.swebench.length} entries`);
  return data;
}

// ============================================================
// 3. Arena AI Leaderboard
// ============================================================
async function fetchArenaAI(page) {
  console.log('⚔️ Fetching Arena AI...');
  const url = 'https://lmarena.ai/leaderboard/text';
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await waitForContent(page, 'table');
  await autoScroll(page);
  
  const data = await page.evaluate(() => {
    const result = {
      textLeaderboard: [],
      categories: [],
      fetchedAt: new Date().toISOString()
    };
    
    // Main leaderboard table
    const table = document.querySelector('table tbody');
    if (table) {
      const headers = [];
      const thead = document.querySelector('table thead tr');
      if (thead) {
        thead.querySelectorAll('th').forEach(th => {
          headers.push(th.textContent.trim());
        });
      }
      
      table.querySelectorAll('tr').forEach(tr => {
        const cells = tr.querySelectorAll('td');
        if (cells.length >= 2) {
          const row = {};
          cells.forEach((cell, i) => {
            row[headers[i] || `col${i}`] = cell.textContent.trim();
          });
          result.textLeaderboard.push(row);
        }
      });
    }
    
    // Category pills/tags
    document.querySelectorAll('.category-tag, .pill, [data-category]').forEach(el => {
      result.categories.push(el.textContent.trim());
    });
    
    return result;
  });
  
  console.log(`  ✓ Arena: ${data.textLeaderboard.length} models`);
  return data;
}

// ============================================================
// 4. TERMS-Bench
// ============================================================
async function fetchTermsBench(page) {
  console.log('🤝 Fetching TERMS-Bench...');
  const url = 'https://terms-bench.github.io/?theme=light&regime=overall&family_kind=all&difficulty_kind=all&diag_kind=all&commerce_src=grounded&commerce_persp=all&bankroll_src=synthetic&bankroll_mode=pool&bankroll_stats=mean';
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await waitForContent(page, 'table', 20000);
  await new Promise(r => setTimeout(r, 3000));
  
  const data = await page.evaluate(() => {
    const result = {
      main: { overall: [], overlap: [], urgency: [], nodeal: [] },
      commerce: {},
      bankroll: [],
      difficulty: [],
      robustness: [],
      diagnostics: {},
      fetchedAt: new Date().toISOString()
    };
    
    // Main table
    function extractTable(tableEl) {
      if (!tableEl) return [];
      const rows = [];
      tableEl.querySelectorAll('tbody tr').forEach(tr => {
        const cells = [];
        tr.querySelectorAll('td').forEach(td => cells.push(td.textContent.trim()));
        if (cells.length > 0) rows.push(cells);
      });
      return rows;
    }
    
    const mainTable = document.querySelector('table');
    if (mainTable) {
      result.main.overall = extractTable(mainTable);
    }
    
    return result;
  });
  
  // Fetch different regimes
  const regimes = [
    { key: 'overlap', param: 'overlap' },
    { key: 'urgency', param: 'urgency_shift' },
    { key: 'nodeal', param: 'no_deal' }
  ];
  
  for (const regime of regimes) {
    try {
      console.log(`  Fetching regime: ${regime.key}...`);
      await page.goto(`https://terms-bench.github.io/?theme=light&regime=${regime.param}`, { 
        waitUntil: 'networkidle2', timeout: 20000 
      });
      await waitForContent(page, 'table', 15000);
      await new Promise(r => setTimeout(r, 2000));
      
      const regimeData = await page.evaluate(() => {
        const table = document.querySelector('table');
        if (!table) return [];
        const rows = [];
        table.querySelectorAll('tbody tr').forEach(tr => {
          const cells = [];
          tr.querySelectorAll('td').forEach(td => cells.push(td.textContent.trim()));
          if (cells.length > 0) rows.push(cells);
        });
        return rows;
      });
      
      data.main[regime.key] = regimeData;
    } catch (e) {
      console.warn(`  Warning: Failed to fetch regime ${regime.key}: ${e.message}`);
    }
  }
  
  console.log(`  ✓ TERMS: overall=${data.main.overall.length}, overlap=${data.main.overlap.length}`);
  return data;
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log('🚀 Starting AI Rankings data fetch...\n');
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--window-size=1920,1080'
    ]
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  const snapshot = {
    version: '1.0',
    fetchedAt: new Date().toISOString(),
    sources: {}
  };
  
  // Fetch each source (with error recovery)
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
  console.log(`\n✅ Snapshot saved to ${SNAPSHOT_FILE}`);
  console.log(`   Total size: ${(fs.statSync(SNAPSHOT_FILE).size / 1024).toFixed(1)} KB`);
  
  // Also save a metadata file for the page to check
  const meta = {
    lastUpdated: snapshot.fetchedAt,
    sources: Object.keys(snapshot.sources).reduce((acc, k) => {
      acc[k] = { 
        status: snapshot.sources[k].error ? 'error' : 'ok',
        itemCount: snapshot.sources[k].leaderboard?.week?.length || 
                   snapshot.sources[k].swebench?.length ||
                   snapshot.sources[k].textLeaderboard?.length ||
                   snapshot.sources[k].main?.overall?.length || 0
      };
      return acc;
    }, {})
  };
  fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
  
  return snapshot;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
