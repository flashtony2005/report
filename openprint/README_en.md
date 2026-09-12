<p align="center">
  <img src="screenshots/logo.png" width="120" alt="OpenPrint Logo" />
</p>

<h1 align="center">OpenPrint</h1>

<p align="center">
  <strong>Open-Source Web Print Designer · AI-Powered · Framework-Agnostic · Cross-Platform</strong>
</p>

<p align="center">
  English | <a href="README.md">简体中文</a> | <a href="README_ja.md">日本語</a>
</p>

<p align="center">
  <a href="https://github.com/haiming236/openprint/stargazers"><img src="https://img.shields.io/github/stars/haiming236/openprint?style=flat-square&logo=github" alt="Stars" /></a>
  <a href="https://github.com/haiming236/openprint/releases"><img src="https://img.shields.io/github/v/release/haiming236/openprint?style=flat-square&logo=github" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="License" /></a>
  <a href="https://vuejs.org/"><img src="https://img.shields.io/badge/Vue_3-4FC08D?style=flat-square&logo=vue.js&logoColor=white" alt="Vue 3" /></a>
  <a href="https://www.naiveui.com/"><img src="https://img.shields.io/badge/Naive_UI-18A058?style=flat-square&logo=naiveui&logoColor=white" alt="Naive UI" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://github.com/fabricjs/fabric.js"><img src="https://img.shields.io/badge/Fabric.js-7.x-blue?style=flat-square" alt="Fabric.js" /></a>
  <a href="https://www.npmjs.com/package/openprint26"><img src="https://img.shields.io/npm/v/openprint26?style=flat-square&logo=npm&logoColor=white" alt="npm" /></a>
</p>

<p align="center">
  <a href="#key-highlights">Key Highlights</a> ·
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#ai-assistant">AI Assistant</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#deployment">Deployment</a> ·
  <a href="#faq">FAQ</a>
</p>
<br />

🚀 **Developers welcome** — We invite developers around the world to join the OpenPrint open-source community: contribute code, file issues, share ideas, and help build a better print solution together!

**OpenPrint** is an open-source, zero-backend visual designer for print templates. Design shipping labels, invoices, barcodes, tags, and reports by drag & drop, with one-sentence AI template generation, cloud printing, and silent printing via the bundled C++ desktop client — connect your ERP system in 3 minutes.

> Pure front-end architecture: no server, no database — everything runs in the browser.

> **Framework-agnostic design** — The core rendering engine is fully decoupled from the UI layer. The designer is built on Vue 3 + Naive UI, while the rendering engine is pure TypeScript and integrates seamlessly with React, Vue, Angular, vanilla JS, or any other stack.

![Designer UI](screenshots/designer-overview.png)
*WYSIWYG print template designer with drag & drop controls and live preview*

---

## Table of Contents

- [Key Highlights](#key-highlights)
- [Features](#features)
- [Quick Start](#quick-start)
- [AI Assistant](#ai-assistant)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Deployment](#deployment)
- [Desktop Client](#desktop-client)
- [ERP Integration](#erp-integration)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

---

## Key Highlights

### 🔌 Framework-Agnostic, Decoupled Engine & UI

OpenPrint separates the **engine layer** from the **UI layer**:

- **Rendering engine** — pure TypeScript, zero framework dependencies. Handles template parsing, data binding, pagination, and HTML/PDF/SVG rendering & export
- **Designer UI** (`openprint26`) — a visual drag & drop designer built on Vue 3 + Naive UI

Whether your project uses **React, Vue, Angular**, or **vanilla JS**, integration is straightforward:

| Integration | Description |
|-------------|-------------|
| **Vue 3 project** | Install `openprint26` and use the `<OpenPrintDesigner />` component |
| **React project** | Render templates via the engine SDK, or embed the designer via iframe / Web Components |
| **Angular project** | Engine SDK rendering + designer embedded via iframe |
| **Vanilla JS / any framework** | Zero-dependency engine SDK — `render({ template, data })` outputs HTML |

### 🤖 One-Sentence AI Template Generation

Skip manual drag & drop — just describe what you need and get a professional print template. Supports shipping labels, logistics tags, warehouse documents, retail receipts, and more.

![AI Assistant](screenshots/ai-assistant.png)
*AI generates print templates from natural language — a shipping label in one sentence*

```
User input:   "Create a shipping label with recipient, sender, and a tracking-number barcode"
AI output:    Create template → place text controls → add barcode → use it in one click
```

### ☁️ Cloud Printing

Remote printing across regions and stores with centrally managed templates. Print directly from the browser — no drivers needed. Cloud print queue, automatic retry on disconnect, permission control, and print log auditing.

![Cloud Print](screenshots/cloud-print.jpg)
*Multi-store remote printing with unified template management and print queue monitoring*

### 📊 Web Report Design

Multi-level report structures: grouped tables, cross-tabs, master-detail. Aggregation functions (sum/average/count), embedded bar/line/pie charts, conditional formatting for data alerts, and multi-datasource joins.

![Report Design](screenshots/report-design.png)
*Grouped reports, cross-tabs, and charts for complex data presentation*

---

## Features

### Designer

| Feature | Description |
|---------|-------------|
| **Control library** | 14 control types: text, image, rectangle, circle, line, barcode, QR code, table, rich text, chart, zone, math formula, signature, label grid |
| **Drag & drop design** | WYSIWYG editing with free dragging, snap alignment, and ruler guides |
| **Multi-page support** | Multi-page design with per-page headers/footers and adjustable page gaps |
| **Data binding** | JSON / CSV / API datasources, Mustache binding with built-in expression functions |
| **Theme switching** | Naive UI dark/light theme, one-click toggle |
| **Framework-agnostic** | Pure-TypeScript engine layer — works with React/Vue/Angular/vanilla JS |
| **Template management** | Local storage, template import/export, template marketplace |
| **Live preview** | Preview data binding results with pagination |
| **Export** | PDF / JPG / SVG / HTML multi-format export |

### Printing & Integration

- **Direct web printing** — browser print dialog, no setup
- **Silent desktop printing** — bundled C++ Qt client, zero popups
- **Cloud printing** — remote store printing with queue management
- **ERP integration** — HTTP API, up and running in 3 minutes

### Tech Stack

#### Designer UI Layer

![Vue 3](https://img.shields.io/badge/Vue_3-4FC08D?style=flat-square&logo=vue.js&logoColor=white)
![Naive UI](https://img.shields.io/badge/Naive_UI-18A058?style=flat-square&logo=naiveui&logoColor=white)
![Fabric.js](https://img.shields.io/badge/Fabric.js-7.x-blue?style=flat-square)
![Pinia](https://img.shields.io/badge/Pinia-FFD859?style=flat-square&logo=pinia&logoColor=black)

#### Core Engine Layer (Framework-Agnostic)

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white)
![Vitest](https://img.shields.io/badge/Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white)
![UnoCSS](https://img.shields.io/badge/UnoCSS-333333?style=flat-square&logo=unocss&logoColor=white)

> The engine layer is framework-free; the designer UI is built on Vue 3 + Naive UI. React / Angular / vanilla JS projects integrate through the engine SDK.

---

## Quick Start

### npm Install

```bash
# npm
npm i openprint26

# pnpm
pnpm add openprint26

# yarn
yarn add openprint26
```

### Use in a Vue 3 Project

```ts
import { createApp } from 'vue'
import OpenPrint from 'openprint26'
import 'openprint26/dist/style.css'

const app = createApp(App)
app.use(OpenPrint)
app.mount('#app')
```

```vue
<template>
  <OpenPrintDesigner />
</template>
```

### Use in a React Project

Embed the designer via iframe; render templates directly through the engine SDK:

```tsx
import { useEffect, useRef } from 'react'
import { render } from 'openprint26/sdk'

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Engine rendering — framework-free, outputs HTML
    let cancelled = false
    render({ template: templateJson, data }).then(({ html }) => {
      if (!cancelled) containerRef.current!.innerHTML = html
    })
    return () => { cancelled = true }
  }, [])

  return (
    <>
      {/* Designer: embed via iframe */}
      <iframe src="/openprint/designer.html" width="100%" height="600" />
      {/* Rendered output */}
      <div ref={containerRef} />
    </>
  )
}
```

### Use in Vanilla JS / Any Framework

```ts
// Engine SDK — zero dependencies, pure TypeScript
import { render, renderDocument } from 'openprint26/sdk'

// 1. Render a template + data into multi-page HTML (async)
const { html, pages, warnings } = await render({
  template: templateJson,
  data: {
    sender_name: 'Alice',
    receiver_name: 'Bob',
    tracking_no: 'SF1234567890',
  },
})
document.getElementById('print-area').innerHTML = html

// 2. Layout only, without HTML — for PDF/image exporters
const layoutResult = await renderDocument({ template: templateJson, data })

// 3. Embed the designer via iframe
// <iframe src="openprint26/designer.html" />
```

### Run from Source

```bash
# Clone the repository
git clone https://gitee.com/haiming236/openprint.git
cd openprint

# Install dependencies
pnpm install

# Start the dev server
pnpm dev

# Build for production
pnpm build

# Preview the production build
pnpm preview
```

### Requirements

- Node.js >= 22.18.0 (or >= 24.12.0)
- pnpm >= 9.x

### Online Demo

Try the designer online at [https://openprint.yy360.space](https://openprint.yy360.space).

---

## AI Assistant

OpenPrint ships with a built-in AI assistant that generates print templates from natural language.

### Usage

1. **New template** — describe what you need and the AI generates a complete template
2. **Modify current template** — select a control and let the AI adjust layout or styles
3. **Field grounding** — data fields are detected automatically and bound to template controls

### How It Works

- An LLM parses user intent and outputs a structured template description
- An internal normalization engine converts the description into Fabric.js control configs
- Context-aware: supports incremental edits on existing templates

### Supported Scenarios

- Shipping labels (SF Express, JD, China Post style layouts)
- Logistics tags (tracking number, destination, weight)
- Warehouse documents (inbound, outbound, stocktaking)
- Retail receipts (POS receipts, return/exchange slips)
- Invoices (VAT invoices, receipts)
- Custom reports

---

## Architecture

OpenPrint separates the **engine layer** from the **UI layer**. The core engine has no framework dependencies and can be called from any front-end stack:

```
┌─────────────────────────────────────────────────────────────────────┐
│                       UI Layer (replaceable)                        │
│                                                                     │
│   ┌─────────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│   │ Vue 3 + Naive UI │  │   React      │  │ Vanilla JS / Angular  │ │
│   │ Designer (official)│ │  Custom UI   │  │ iframe / Web Component│ │
│   └────────┬────────┘  └──────┬───────┘  └──────────┬────────────┘ │
│            └───────────────────┴─────────────────────┘              │
│                                │ SDK API                            │
╞════════════════════════════════╪═══════════════════════════════════╡
│                     Engine Layer (framework-free)                   │
│                                ▼                                    │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │            Layout Engine — pure TypeScript                    │ │
│  │  Data binding │ Expressions │ Pagination │ Tables │ Grouping  │ │
│  └───────────────────────────┬───────────────────────────────────┘ │
│                              ▼                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │            Renderer — pure TypeScript                         │ │
│  │  HTML render │ PDF export │ JPG export │ SVG │ Rich text      │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                               │
                      ┌────────┴────────┐
                      ▼                 ▼
             ┌──────────────┐  ┌──────────────┐
             │ C++ Qt client │  │ Cloud print  │
             │ silent print  │  │ remote print │
             └──────────────┘  └──────────────┘
```

### Layer Overview

| Layer | Technology | Description |
|-------|------------|-------------|
| **Designer UI** | Vue 3 + Naive UI + Fabric.js | Official visual designer: drag & drop, property panels, layer management |
| **Layout engine** | Pure TypeScript | Template parsing, data binding, pagination, tables, grouping, expressions |
| **Renderer** | Pure TypeScript | HTML/PDF/JPG/SVG multi-format rendering & export, framework-free |
| **AI assistant** | TypeScript | LLM intent parsing, template generation, context management |
| **Desktop client** | C++ + Qt | Silent printing, batch printing, printer management |

### Core Modules

| Module | Path | Description |
|--------|------|-------------|
| **Layout engine** | `src/core/layout-engine/` | Data binding, pagination, tables, grouping, expressions (framework-free) |
| **HTML renderer** | `src/core/renderer-html/` | HTML rendering, CSS generation, rich text (framework-free) |
| **Export engine** | `src/core/export-engine/` | PDF, JPG, SVG export (framework-free) |
| **SDK** | `src/core/sdk/` | Engine API wrapper for any framework |
| **Print client** | `src/core/print-client/` | Desktop client protocol, DPI-aware rendering, orientation |
| **Charts** | `src/core/chartkit/` | SVG chart rendering: bar / line / pie |
| **Math formulas** | `src/core/mathkit/` | KaTeX-based formula rendering |
| **Fonts** | `src/core/fonts/` | Font catalog, loading, system font registration |
| **Headless** | `src/core/headless/` | Headless (off-DOM) rendering |
| **Spec & validation** | `src/core/spec/` | Template schema and validation |
| **Designer** | `src/design/` | Vue 3 + Naive UI designer interface |
| **AI assistant** | `src/ai/` | AI template generation, context management |
| **Controls** | `src/design/canvas/controls/` | 14 Fabric.js print controls |

---

## Project Structure

```
openprint/
├── src/
│   ├── ai/                        # AI assistant (generation / normalization / client)
│   ├── core/                      # Core engine
│   │   ├── layout-engine/         # Layout engine (binding / pagination / tables / grouping)
│   │   ├── renderer-html/         # HTML renderer
│   │   ├── export-engine/         # Export engine (PDF / JPG / SVG)
│   │   ├── chartkit/              # Chart rendering (bar / line / pie)
│   │   ├── mathkit/               # Math formula rendering (KaTeX)
│   │   ├── print-client/          # Desktop client protocol / DPI / orientation
│   │   ├── fonts/                 # Font loading & management
│   │   ├── headless/              # Headless rendering
│   │   ├── spec/                  # Template spec & validation
│   │   └── sdk/                   # SDK wrapper
│   ├── design/                    # Designer interface
│   │   ├── canvas/                # Canvas & controls
│   │   ├── panels/                # Property / layer / datasource panels
│   │   ├── preview/               # Preview panel
│   │   ├── toolbar/               # Top toolbar
│   │   ├── modals/                # Modals (import / export / settings)
│   │   └── stores/                # Pinia state management
│   ├── repository/                # Repositories (local / HTTP / mock)
│   ├── types/                     # TypeScript type definitions
│   ├── config/                    # Config (print settings / AI settings)
│   ├── theme/                     # Theme system
│   └── utils/                     # Utilities
├── public/                        # Static assets
├── screenshots/                   # README screenshots
└── dist/                          # Build output
```

---

## Deployment

### Static Hosting

The build output is fully static and can be served from any HTTP server:

```bash
pnpm build
# Deploy the dist/ directory to Nginx / Apache / Vercel / Netlify, etc.
```

### Nginx Example

```nginx
server {
    listen 80;
    server_name your-domain.com;
    root /path/to/openprint/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### Docker

```dockerfile
FROM nginx:alpine
COPY dist/ /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

---

## Desktop Client

OpenPrint ships with a companion **C++ Qt desktop print client** supporting:

- **Silent printing** — receives designer templates and sends them straight to local printers, zero popups
- **Batch printing** — batch rendering & printing from CSV/JSON data
- **Local printer management** — list printers, monitor status
- **HTTP interface** — receives print jobs via REST API
- **Cross-platform** — Windows / Linux / macOS

![Desktop Client](screenshots/desktop-client.jpg)
*C++ Qt desktop client: silent printing with batch processing*

### Tech Stack

![C++](https://img.shields.io/badge/C++-20-00599C?style=flat-square&logo=cplusplus&logoColor=white)
![Qt](https://img.shields.io/badge/Qt-6.x-41CD52?style=flat-square&logo=qt&logoColor=white)
![CMake](https://img.shields.io/badge/CMake-064F8C?style=flat-square&logo=cmake&logoColor=white)

---

## ERP Integration

OpenPrint provides a standard HTTP API — connect your ERP in 3 minutes:

### Integration Flow

1. **Design a template** — build the print template in the web designer
2. **Export the template file** — export as a `.json` file
3. **API integration** — the ERP pushes data + template ID over HTTP to trigger printing

![ERP Integration](screenshots/erp-integration.jpg)
*Standard HTTP API — connect your ERP in 3 minutes*

### API Example

```http
POST /api/print
Content-Type: application/json

{
  "template_id": "waybill-001",
  "data": {
    "sender_name": "Alice",
    "sender_phone": "13800138000",
    "receiver_name": "Bob",
    "receiver_address": "Chaoyang District, Beijing..."
  },
  "printer": "local-printer-01",
  "copies": 1
}
```

---

## FAQ

### How do I install OpenPrint?

```bash
npm i openprint26
```

See the [Quick Start](#quick-start) section for details.

### Does it support React / Angular / vanilla JS?

Yes. The core rendering engine is pure TypeScript with zero framework dependencies. The designer is built on Vue 3 + Naive UI and can be embedded into any framework via iframe or Web Components. The engine SDK provides `render()`, `renderDocument()`, and more, callable from any JS environment.

### What UI component library does the designer use?

The designer UI is built on [Naive UI](https://www.naiveui.com/) with Vue 3 + Fabric.js. Naive UI offers full dark/light theme support, a rich component set, and a great developer experience.

### Does OpenPrint need a backend?

No. OpenPrint is a pure front-end app with zero backend dependencies. Templates are stored in the browser (IndexedDB), and AI features call the LLM API directly. An optional desktop client can be deployed for printer/ERP integration.

### Which browsers are supported?

Modern browsers: Chrome / Edge / Firefox / Safari. Chromium-based browsers are recommended for the best experience.

### How do I add custom fonts?

Place font files (`.ttf` / `.woff2`) in `public/fonts/` and register them in `src/core/fonts/catalog.ts`.

The desktop client can also scan and register all system fonts.

### Does it support batch printing?

Yes. With CSV/JSON datasources and the template engine you can batch-generate multi-page documents for export or printing. The desktop client supports batch silent printing.

### How do I share a template with others?

Export the template as a `.json` file; others can load it via import. URL-encoded sharing is also supported (zero backend).

---

## Contributing

Contributions, issues, and suggestions are welcome!

### Workflow

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Commit Convention

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation
- `refactor:` refactoring
- `test:` tests
- `chore:` build / tooling

### Development Commands

```bash
# Run tests
pnpm vitest

# Type checking
pnpm type-check

# Format code
pnpm format

# Test coverage
pnpm vitest --coverage
```

---

## Sponsoring

OpenPrint is an open-source project. If you find it helpful, feel free to sponsor its ongoing development and maintenance. Add a note with your payment so we can prioritize support for you.

<table>
  <tr>
    <td align="center">
      <img src="screenshots/sponsor-wechat.jpg" width="200" alt="WeChat Pay" />
      <br />
      <sub>WeChat Pay</sub>
    </td>
    <td align="center">
      <img src="screenshots/sponsor-alipay.jpg" width="200" alt="Alipay" />
      <br />
      <sub>Alipay</sub>
    </td>
  </tr>
</table>
### Sponsors

Thanks to the following sponsors (chronological order):

| Name | Amount | Date |
|------|--------|------|
| _JiaYang_ | 99 | 2026-08-14 |

---

## License

[AGPL-3.0 License](LICENSE)

Copyright (c) 2025 OpenPrint

---

<p align="center">
  <b>OpenPrint</b> — Making printing simple and efficient
</p>
<p align="center">
  <a href="https://github.com/haiming236/openprint">GitHub</a> ·
  <a href="https://gitee.com/haiming236/openprint">Gitee</a> ·
  <a href="https://openprint.yy360.space">Online Demo</a>
</p>
