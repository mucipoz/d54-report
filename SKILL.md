---
name: d54-report
description:
  Use D54 Report through MCP or the CLI for a requested source audit, browser review, report
  interpretation, or approved fix from an existing D54 report.
---

# D54 Report

Use a terminal in the scanner checkout or an installed `d54-report` executable.
Preserve the user's chosen target and destination. After cloning the scanner,
run `npm ci` and `npm run build` on Node.js 20+. For Chromium-based UI review
install the browser with `npx --no-install playwright install chromium`.
[Setup and examples](README.md)

## Connected MCP client

When available, use `d54_scan_project` with the local project `path`, optional
`url` and requested `modules`. Set `use_llm` only for authorized model review.
Consume the returned coverage, summary, high/critical findings and report paths.
Use `d54_get_report` with the returned Markdown path for the full report. For
a fix request, pass its JSON path to `d54_fix_findings` and specify selected
IDs, mode and dry-run choice. Return the applicable verification and publication
statuses. [Connection and permissions](README.md#mcp-sunucusu)

## Audit

1. Use `scan --path` for a local directory, `scan --repo` for a public HTTPS
   GitHub repository, and `--url` for a running page. Combine a source target
   and URL when both are available. Use `--no-browser` for source-only review.
2. Use `--json` for automation. Enable an optional model through the operator's
   configuration or use `--no-llm`. Public advisory lookups can still use the
   network. Reserve `--trusted` for authorized project command execution on
   reviewed local source.
3. Read `coverage`, `summary` and `findings` from the saved JSON. For each
   reported issue preserve the rule, severity and available location. Cite the
   saved Markdown or screenshot path for human review.

```bash
node dist/cli.js scan --path demo-app --no-llm --out reports/demo --json
```

## Fix

Pass the local target and its report to `fix`. Select IDs from that report and
use `--dry-run` for a preview or `--mode patch` for a patch file. For a local
edit or publication, retain the selected mode's approval step. Interpret
`DRY_RUN_UNVERIFIED`, `PATCH_UNVERIFIED`, `SKIPPED` and `PR_FALLBACK` from their
actual detail fields.
[Status table, process codes and command examples](AGENT.md)
