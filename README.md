# Microdemo

A local Rainfrog batch studio. Upload a CSV of brands and process each row through research, product collection, native canvas setup, image generation and download.

Each brand finishes before the next begins. Approvals, errors and incomplete downloads pause the current brand; resuming preserves completed brands and accepted generations.

## Requirements

- Node.js 22 or later and npm.
- An installed, authenticated Codex CLI available on `PATH`, or its absolute path in `config.json`.
- Rainfrog access through its OAuth MCP connection, an editable workspace and generation credits.
- Google Chrome installed for mandatory Instagram visual research.

## Install

```sh
git clone https://github.com/leonepietrantonio/microdemo.git
cd microdemo
npm ci
cp config.example.json config.json
```

Edit `config.json`: set `workspaceId` and `productWorkspaceId` to your Rainfrog workspace ID. Products and projects must share that workspace. Set the workspace names and, if necessary, `codexPath`. Template and style IDs must identify assets available to your account; the supplied configuration includes the native templates and style used by this project.

Connect the local Codex CLI to Rainfrog:

```sh
codex mcp add rainfrog --url https://mcp.rainfrog.ai/mcp
codex mcp login rainfrog
```

Complete OAuth in the browser. Keep credentials out of the repository. On macOS, `Connect Rainfrog.command` can register the MCP connection; complete its OAuth login if needed.

## Run

```sh
npm start
```

Open [the local dashboard](http://127.0.0.1:4318/). On macOS you can also double-click `Start Microdemo.command`.

1. Complete the Rainfrog access check and any required persistent Edit/Generate consent. Batch execution unlocks only after real server grants and workspace access are verified.
2. Upload a CSV or paste its contents and validate it.
3. Set the total batch credit limit, create the batch, then start it.
4. Each brand completes research → preparation → generation → download before the next CSV row starts.

The default permission mode is `standing-grants`. The app verifies Rainfrog's actual permissions; it cannot fabricate grants or bypass server approvals. If the server provides no permission-request tool, persistent access must be configured through a supported Rainfrog consent flow. Optional `per-action` mode uses individual server approvals instead.

The suggested credit limit scales with the CSV at 30 credits per planned visual, with the configured default as its minimum. Your manual edits take precedence. Actual quotes are checked before generation against the remaining batch allowance. Raising a limit and resuming retains completed work. This is an application-level guard; it is not an account-wide provider billing limit.

## CSV format

Use `brands.csv` as a blank starter, or adapt `brands.example.csv`.

```csv
brand_name,instagram_url,website_url
RETROSUPERFUTURE,https://www.instagram.com/retrosuperfuture/,https://retrosuperfuture.com/
```

There is no brand-count limit. Files up to 10 MB are supported. The preview shows the first 20 brands; execution includes every valid row in CSV order. Empty rows are ignored and duplicate brand names are rejected.

| Column | Description |
| --- | --- |
| `brand_name` | Required brand, project and folder name |
| `instagram_url` | Required public Instagram profile URL |
| `website_url` | Required official website URL |
| `shoot_type` | `still_life`, `fashion`, `both`, or `auto`; defaults to `still_life` |
| `product_count` | 1–3 products per brand; defaults to 3 |
| `style` | Compatibility field; configured creative-profile style takes precedence |
| `character_id` | Optional authorized existing Rainfrog character for fashion |
| `notes` | Optional creative preferences |

`both` creates a still life and a fashion visual per product. `auto` chooses one shoot type from the research. Fashion requires an available authorized character. Sample placeholder rows must be replaced before import.

## Creative workflow

- Instagram research uses a dedicated persistent Chrome profile, captures up to nine posts and requires visual review of at least six. If Instagram requests sign-in, use the dashboard's Instagram browser control and sign in there. Website imagery supplements this research.
- Each selected product keeps all distinct eligible gallery photos, up to six, uploaded together into one Rainfrog product.
- Native Product Still Life and Fashion Shooting templates retain their topology. Generation executes the exact wired image-generator node; the connected style is resolved by Rainfrog, never copied into scene text.
- The defaults are **Line Gobo No Back**, **3:4**, and **2K**. Products, briefs, style wiring, native preset and output settings are checked before generation.
- Edit `PEZZO_BRIEF.md` directly or use the dashboard editor. Each brand snapshots the latest brief when its preparation begins and combines it with the researched brand brief. Already prepared sets retain their saved version.

## Outputs and recovery

Live batches are saved under `data/live/batches/<batch-id>/`; simulation uses `data/simulation/`. Each brand has its source images, research evidence, manifests, creative briefs, generated images and report. The dashboard provides image downloads and a batch report CSV.

Pause finishes the active phase and saves its checkpoint. Resume continues that brand's saved phase and skips completed brands. Accepted native execution IDs, request keys and counted credits are preserved to avoid duplicate generations. Export failures never trigger replacement images. Closed batches remain closed.

## Tests and simulation

```sh
npm test
npm run demo
```

Simulation uses labeled SVG placeholders and makes no Rainfrog or research calls. Tests cover large CSV imports, sequential completion, budget checks, permission states, approvals, native execution verification, recovery, output validation and the local HTTP flow. Tests use `config.example.json`; personal configuration is not required.

## Local configuration and data

`config.json`, browser sessions, OAuth state, generated media, batch history and diagnostic records are excluded from Git. The server binds to loopback, enforces same-origin/CSRF checks for dashboard actions and does not expose worker prompts or hidden files as downloads.

Optional environment variables: `PORT`, `MICRODEMO_CONFIG_PATH`, `MICRODEMO_DATA_DIR`, and `MICRODEMO_BRIEF_PATH`. Keep the app local; this project is not configured as a public multi-user service.
