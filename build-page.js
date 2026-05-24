/**
 * AI Rankings Page Builder
 * 
 * Reads the base HTML template and latest snapshot data,
 * then generates an updated index.html with fresh data.
 * 
 * Strategy: The base HTML contains embedded data as fallback.
 * This script updates the embedded data with latest snapshot.
 * 
 * Usage: node build-page.js
 */

const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, 'index.html');
const SNAPSHOT = path.join(__dirname, 'data', 'latest-snapshot.json');
const OUTPUT = path.join(__dirname, 'index.html');

function formatTimestamp(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: 'Asia/Shanghai'
  }) + ' (UTC+8)';
}

function build() {
  console.log('🏗️ Building AI Rankings page...\n');
  
  // Read base template
  let html = fs.readFileSync(TEMPLATE, 'utf-8');
  
  // Read snapshot if exists
  let snapshot = null;
  if (fs.existsSync(SNAPSHOT)) {
    try {
      snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf-8'));
      console.log(`  ✓ Loaded snapshot from ${snapshot.fetchedAt}`);
    } catch (e) {
      console.warn(`  ⚠ Failed to parse snapshot: ${e.message}`);
    }
  }
  
  if (!snapshot) {
    console.log('  ℹ No snapshot data, keeping existing page');
    return;
  }
  
  // Update timestamp
  const ts = formatTimestamp(snapshot.fetchedAt);
  html = html.replace(
    /⏱ 数据获取时间：[^<]*/g,
    `⏱ 数据获取时间：${ts}`
  );
  
  // Update OpenRouter leaderboard data if available
  if (snapshot.sources.openrouter && !snapshot.sources.openrouter.error) {
    const or = snapshot.sources.openrouter;
    
    // Update leaderboard periods
    ['today', 'week', 'month', 'trending'].forEach(period => {
      if (or.leaderboard && or.leaderboard[period] && or.leaderboard[period].length > 0) {
        const rows = or.leaderboard[period].map(item => {
          const changeClass = item.change && item.change.startsWith('+') ? 'up' : 
                             item.change && item.change.startsWith('-') ? 'down' : '';
          const changeText = item.change || '0%';
          return `      <tr><td>${item.rank}</td><td class="model-name">${item.model}<span class="provider">· ${item.provider}</span></td><td>${item.tokens}</td><td class="change ${changeClass}">${changeText}</td></tr>`;
        }).join('\n');
        
        // Try to replace the period table body
        const pattern = new RegExp(`(data-period="${period}"[^>]*>[\\s\\S]*?<tbody>)([\\s\\S]*?)(<\\/tbody>)`, 'g');
        if (html.match(pattern)) {
          html = html.replace(pattern, `$1\n${rows}\n      $3`);
        }
      }
    });
    
    console.log('  ✓ Updated OpenRouter data');
  }
  
  // Update Vals AI data if available
  if (snapshot.sources.valsai && !snapshot.sources.valsai.error) {
    console.log('  ✓ Vals AI data available (structure preserved)');
  }
  
  // Update Arena AI data if available
  if (snapshot.sources.arena && !snapshot.sources.arena.error) {
    console.log('  ✓ Arena AI data available (structure preserved)');
  }
  
  // Update TERMS-Bench data if available
  if (snapshot.sources.terms && !snapshot.sources.terms.error) {
    console.log('  ✓ TERMS-Bench data available (structure preserved)');
  }
  
  // Add data freshness indicator
  const freshnessMeta = `<meta name="data-updated" content="${snapshot.fetchedAt}" />`;
  if (html.includes('data-updated')) {
    html = html.replace(/<meta name="data-updated" content="[^"]*" \/>/g, freshnessMeta);
  } else {
    html = html.replace('</head>', `  ${freshnessMeta}\n</head>`);
  }
  
  // Add auto-refresh script (check for updates every 30 min)
  const autoRefreshScript = `
<script>
// Auto-refresh: check for data updates every 30 minutes
(function() {
  var REFRESH_INTERVAL = 30 * 60 * 1000; // 30 min
  setInterval(function() {
    fetch('data/meta.json?' + Date.now(), { cache: 'no-store' })
      .then(function(r) { return r.json(); })
      .then(function(meta) {
        var el = document.getElementById('updateTime');
        if (el && meta.lastUpdated) {
          var d = new Date(meta.lastUpdated);
          var s = d.toLocaleString('zh-CN', {
            year:'numeric', month:'2-digit', day:'2-digit',
            hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
          });
          el.textContent = '⏱ 数据获取时间：' + s + ' (UTC+8)';
        }
      })
      .catch(function() {});
  }, REFRESH_INTERVAL);
})();
</script>`;
  
  if (!html.includes('Auto-refresh')) {
    html = html.replace('</body>', autoRefreshScript + '\n</body>');
  }
  
  // Write output
  fs.writeFileSync(OUTPUT, html);
  console.log(`\n  ✅ Page built: ${OUTPUT}`);
  console.log(`  📏 Size: ${(fs.statSync(OUTPUT).size / 1024).toFixed(1)} KB`);
}

build();
