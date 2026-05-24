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
// 1. OpenRouter Rankings - API + DOM hybrid approach
//    Strategy: Fetch model data via API, then use the rendered
//    rankings page to determine the ranking order.
// ============================================================
async function fetchOpenRouter(page) {
  console.log('📊 Fetching OpenRouter Rankings...');
  
  const result = {
    leaderboard: {},
    topModels: [],
    fetchedAt: new Date().toISOString()
  };
  
  try {
    // Step 1: Fetch all models from the public API
    console.log('  Step 1: Fetching model data from API...');
    const apiData = await page.evaluate(async () => {
      try {
        const res = await fetch('https://openrouter.ai/api/frontend/models');
        const json = await res.json();
        return json;
      } catch (e) {
        return { error: e.message };
      }
    });
    
    if (apiData.error) {
      throw new Error(`API fetch failed: ${apiData.error}`);
    }
    
    const models = apiData.data || [];
    console.log(`  ✓ API returned ${models.length} models`);
    
    // Build a lookup map by slug and name for enrichment
    const modelMap = {};
    models.forEach(m => {
      modelMap[m.slug] = m;
      if (m.short_name) modelMap[m.short_name] = m;
      if (m.name) modelMap[m.name] = m;
    });
    
    // Step 2: Navigate to rankings page and extract the model order
    console.log('  Step 2: Extracting ranking order from page...');
    const periods = [
      { key: 'week', url: 'https://openrouter.ai/rankings?view=week' },
      { key: 'today', url: 'https://openrouter.ai/rankings?view=day' },
      { key: 'month', url: 'https://openrouter.ai/rankings?view=month' },
      { key: 'trending', url: 'https://openrouter.ai/rankings?view=trending' }
    ];
    
    for (const period of periods) {
      try {
        await page.goto(period.url, { waitUntil: 'networkidle2', timeout: 45000 });
        await new Promise(r => setTimeout(r, 5000));
        
        // Extract model names in the order they appear on the page
        const pageModels = await page.evaluate(() => {
          // The rankings page renders model names as links or text
          const names = [];
          
          // Try links to model pages first
          const links = document.querySelectorAll('a[href*="/models/"]');
          links.forEach(link => {
            const name = link.textContent.trim();
            if (name && name.length > 1 && name.length < 100) {
              const href = link.getAttribute('href') || '';
              const slug = href.replace('/models/', '');
              names.push({ name, slug, source: 'link' });
            }
          });
          
          // If no links found, try extracting from all text content
          if (names.length === 0) {
            const bodyText = document.body.innerText;
            const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 2);
            // Look for known model name patterns
            const modelPatterns = [
              /(?:GPT|Claude|Gemini|Llama|Qwen|Mistral|Grok|DeepSeek|Command|Phi|Mixtral|Nous|Hermes|Dolphin|Mytho|Wizard|Falcon|Stable|Codestral|Mathstral|Pixtral|Voyage|Jamba|DBRX|Yi|Intern|Solar|Arctic|Granite|Granite|Gemma|Reka|Cohere|Aya|Cerebras|Llama3|o1|o3|o4|R1|R1-)\S*/gi,
              /[a-z0-9-]+\/[a-z0-9.-]+/g  // slug pattern like "openai/gpt-4o"
            ];
            
            const found = new Set();
            for (const pattern of modelPatterns) {
              let match;
              while ((match = pattern.exec(bodyText)) !== null) {
                const m = match[0];
                if (!found.has(m) && m.length > 3) {
                  found.add(m);
                  names.push({ name: m, slug: '', source: 'regex' });
                }
              }
            }
            
            // If still nothing, just grab the non-empty lines that look like model names
            if (names.length === 0) {
              for (const line of lines) {
                if (line.length > 3 && line.length < 80 && 
                    !line.startsWith('Skip') && !line.startsWith('OpenRouter') &&
                    !line.startsWith('Models') && !line.startsWith('Based on') &&
                    line !== 'No models found') {
                  names.push({ name: line, slug: '', source: 'line' });
                }
              }
            }
          }
          
          return names;
        });
        
        console.log(`  ${period.key}: Found ${pageModels.length} model references on page`);
        
        // Step 3: Merge API data with page ordering to build leaderboard
        const leaderboard = [];
        const seen = new Set();
        
        for (const pm of pageModels) {
          // Try to find the full model data
          let model = modelMap[pm.slug] || modelMap[pm.name];
          
          // If slug is like "openai/gpt-4o", try matching
          if (!model && pm.slug) {
            model = models.find(m => m.slug === pm.slug || m.slug === pm.name);
          }
          if (!model && pm.name) {
            model = models.find(m => m.short_name === pm.name || m.name === pm.name || 
                                    m.name.includes(pm.name) || pm.name.includes(m.short_name || ''));
          }
          
          const modelId = model ? model.slug : pm.name;
          if (seen.has(modelId)) continue;
          seen.add(modelId);
          
          const rank = leaderboard.length + 1;
          const pricing = model?.pricing || {};
          const promptPrice = parseFloat(pricing.prompt || 0);
          const completionPrice = parseFloat(pricing.completion || 0);
          
          leaderboard.push({
            rank,
            model: model?.short_name || model?.name || pm.name,
            slug: model?.slug || pm.slug || '',
            provider: model?.author_display_name || model?.author || '',
            contextLength: model?.context_length || 0,
            isFree: model?.is_free || false,
            supportsReasoning: model?.supports_reasoning || false,
            inputModalities: model?.input_modalities || [],
            outputModalities: model?.output_modalities || [],
            promptPricePerM: promptPrice > 0 ? (promptPrice * 1000000).toFixed(2) : '0',
            completionPricePerM: completionPrice > 0 ? (completionPrice * 1000000).toFixed(2) : '0',
            source: pm.source
          });
          
          if (leaderboard.length >= 50) break;
        }
        
        result.leaderboard[period.key] = leaderboard;
        console.log(`  ✓ ${period.key}: ${leaderboard.length} ranked models`);
        
      } catch (e) {
        console.warn(`  ✗ ${period.key}: ${e.message}`);
        result.leaderboard[period.key] = [];
      }
    }
    
    // Build topModels summary from week ranking
    result.topModels = (result.leaderboard.week || []).slice(0, 20);
    
  } catch (e) {
    console.warn(`  ✗ OpenRouter failed: ${e.message}`);
    result.error = e.message;
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
