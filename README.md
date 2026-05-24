# 🏆 AI 模型排行榜 — 统一中文版

> 整合 OpenRouter、Vals AI、Arena AI、TERMS-Bench 四大数据源的 AI 模型排行榜

🌐 **在线访问**: [https://hahapkpk.github.io/ai-rankings](https://hahapkpk.github.io/ai-rankings)

## 📊 数据来源

| 数据源 | 说明 | 更新频率 |
|--------|------|----------|
| 🔄 [OpenRouter](https://openrouter.ai/rankings) | 用量与市场份额排行 | 每日3次 |
| 🧪 [Vals AI](https://www.vals.ai/) | SWE-bench 等基准测试排行 | 每日3次 |
| ⚔️ [Arena AI](https://lmarena.ai/) | 盲测 Elo 评分 | 每日3次 |
| 🤝 [TERMS-Bench](https://terms-bench.github.io/) | LLM 谈判智能体诊断基准 | 每日3次 |

## 🕐 自动刷新

GitHub Actions 每天3次自动抓取最新数据并部署：
- **08:00 CST** (UTC 0:00)
- **14:00 CST** (UTC 6:00)  
- **20:00 CST** (UTC 12:00)

也可手动触发：`Actions → Update AI Rankings → Run workflow`

## 🎨 功能特色

- 6 种主题切换（深色/浅色/暖色/森林/海洋/赛博）
- 4 个数据源一键切换
- 中文本地化翻译
- 数据更新状态实时检测
- 响应式布局

## 🔧 本地开发

```bash
# 安装依赖
npm install

# 抓取最新数据
npm run fetch

# 构建页面
npm run build

# 一键更新
npm run update
```

## 📁 项目结构

```
├── index.html           # 主页面
├── fetch-data.js         # 数据抓取脚本 (Puppeteer)
├── build-page.js         # 页面构建脚本
├── data/
│   ├── meta.json         # 数据元信息
│   └── latest-snapshot.json  # 最新数据快照
├── .github/workflows/
│   └── update-ai-rankings.yml  # 自动更新工作流
└── package.json
```
