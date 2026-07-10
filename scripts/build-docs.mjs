import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DOCS_SRC = path.join(__dirname, '..', 'docs')
const OUT_DIR = path.join(__dirname, '..', 'public', 'guide')

const PAGES = [
  { slug: 'introduction', title: 'Introduction', file: 'introduction.md' },
  { slug: 'quickstart', title: 'Quickstart', file: 'quickstart.md' },
  { slug: 'authentication', title: 'Authentication', file: 'authentication.md' },
  { slug: 'guides', title: 'Guides', file: 'guides.md' },
  { slug: 'webhook-events', title: 'Webhook Events', file: 'webhook-events.md' },
  { slug: 'error-codes', title: 'Error Codes', file: 'error-codes.md' },
  { slug: 'changelog', title: 'Changelog', file: 'changelog.md' },
]

marked.use({
  renderer: {
    // Rewrite relative .md links (./quickstart.md, ./guides.md#anchor) to site-relative .html links
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens)
      const rewritten = href.replace(/^\.\/([a-z-]+)\.md/, '$1.html')
      const titleAttr = title ? ` title="${title}"` : ''
      return `<a href="${rewritten}"${titleAttr}>${text}</a>`
    },
  },
})

function layout({ title, activeSlug, bodyHtml }) {
  const nav = PAGES.map(
    (p) =>
      `<a href="${p.slug}.html" class="${p.slug === activeSlug ? 'active' : ''}">${p.title}</a>`,
  ).join('\n        ')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — Zap Developer Docs</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22><text y=%2220%22 font-size=%2220%22>⚡</text></svg>" />
<style>
  :root {
    --accent: #C8935A;
    --bg: #FAF3E8;
    --panel: #FFFFFF;
    --text: #2A2118;
    --text-muted: #6B5D4F;
    --border: #E6D9C6;
    --code-bg: #2A2118;
    --code-text: #F3E9DA;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    display: flex;
    min-height: 100vh;
  }
  nav.sidebar {
    width: 240px;
    flex-shrink: 0;
    background: var(--panel);
    border-right: 1px solid var(--border);
    padding: 24px 16px;
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
  }
  nav.sidebar .brand {
    font-weight: 700;
    font-size: 1.15rem;
    color: var(--accent);
    margin-bottom: 4px;
    display: block;
    text-decoration: none;
  }
  nav.sidebar .brand-sub {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-bottom: 24px;
    display: block;
  }
  nav.sidebar a {
    display: block;
    padding: 8px 12px;
    border-radius: 6px;
    color: var(--text);
    text-decoration: none;
    font-size: 0.92rem;
    margin-bottom: 2px;
  }
  nav.sidebar a:hover { background: var(--bg); }
  nav.sidebar a.active { background: var(--accent); color: white; font-weight: 600; }
  nav.sidebar .api-ref {
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }
  main {
    flex: 1;
    max-width: 860px;
    padding: 48px 56px;
  }
  main h1 { font-size: 2rem; margin-top: 0; }
  main h2 { font-size: 1.4rem; margin-top: 2.5rem; border-bottom: 1px solid var(--border); padding-bottom: 0.4rem; }
  main h3 { font-size: 1.1rem; margin-top: 1.8rem; color: var(--accent); }
  main p, main li { line-height: 1.65; color: var(--text); }
  main a { color: var(--accent); }
  code {
    background: rgba(200, 147, 90, 0.15);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.88em;
    font-family: "SF Mono", Menlo, Consolas, monospace;
  }
  pre {
    background: var(--code-bg);
    color: var(--code-text);
    padding: 18px 20px;
    border-radius: 10px;
    overflow-x: auto;
    font-size: 0.86rem;
    line-height: 1.55;
  }
  pre code { background: none; padding: 0; color: inherit; }
  table { border-collapse: collapse; width: 100%; margin: 1.2rem 0; }
  th, td { text-align: left; padding: 8px 12px; border: 1px solid var(--border); font-size: 0.92rem; }
  th { background: rgba(200, 147, 90, 0.12); }
  blockquote { border-left: 3px solid var(--accent); margin: 1rem 0; padding: 0.2rem 1rem; color: var(--text-muted); }
  @media (max-width: 800px) {
    body { flex-direction: column; }
    nav.sidebar { width: 100%; height: auto; position: static; }
    main { padding: 24px; }
  }
</style>
</head>
<body>
  <nav class="sidebar">
    <a href="introduction.html" class="brand">⚡ Zap</a>
    <span class="brand-sub">Developer Docs</span>
    ${nav}
    <div class="api-ref">
      <a href="/docs">API Reference ↗</a>
    </div>
  </nav>
  <main>
    ${bodyHtml}
  </main>
</body>
</html>
`
}

fs.mkdirSync(OUT_DIR, { recursive: true })

for (const page of PAGES) {
  const src = fs.readFileSync(path.join(DOCS_SRC, page.file), 'utf8')
  const bodyHtml = marked.parse(src)
  const html = layout({ title: page.title, activeSlug: page.slug, bodyHtml })
  fs.writeFileSync(path.join(OUT_DIR, `${page.slug}.html`), html)
  console.log(`built public/guide/${page.slug}.html`)
}

// index.html redirects to the introduction
fs.writeFileSync(
  path.join(OUT_DIR, 'index.html'),
  `<!doctype html><meta http-equiv="refresh" content="0; url=introduction.html">`,
)
console.log('built public/guide/index.html (redirect)')
