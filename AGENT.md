# D54 Report agent contract

<!-- markdownlint-configure-file
{"MD013":{"tables":false,"code_blocks":false}}
-->

Any coding agent with terminal access can call the same CLI and read the same
JSON. Use the project and operations authorized by the user. For installation
from a clean checkout, use Node.js 20+, `npm ci`, `npm run build`, and
optionally `npm link`. The examples below run from the D54 checkout.
[Setup and provider configuration](README.md)

## MCP access

For a local target, a connected stdio client can call the tools below. The
operator starts the server with `d54-report-mcp`. Tool arguments contain paths
on that server's filesystem. [Client configuration and examples](README.md#mcp-sunucusu)

1. Call `d54_scan_project` with `path`, optional `url`, optional `modules`
   and optional `use_llm` (default false). Read `summary`, `coverage`,
   `critical_high`, `browser_unavailable` and `modules` from
   `structuredContent`. The JSON and Markdown paths are in `report_paths`.
2. Use `d54_get_report` with `report_path` set to either returned file path
   to read the entire Markdown document as text.
3. Call `d54_fix_findings` with the returned JSON path in `report_path`,
   optional `ids` and `severity` filters, `mode` (`patch` or `pr`) and
   `dry_run`. Report `patch_paths` and the status and verification steps for
   each entry in `results`. The `successful` and `rolled_back` arrays are
   subsets. Privileged validation requires the operator's exact trusted root.
   A real PR action requires client form approval or explicit server publication
   permission for that root.

## Collect a report

```bash
mkdir -p reports/agent
node dist/cli.js scan --path demo-app --out reports/agent \
  --no-llm --no-browser --json > reports/agent/input.json
```

For a visual review, install Chromium and omit `--no-browser`. For an existing
server, pass `--url` with an authorized HTTP(S) page. `--repo` takes a public
HTTPS GitHub repository. For several views or URLs, run a separate scan for
each. Choose `--trusted` only when running the reviewed local project's own
commands is authorized. Model configuration belongs to the operator. Supply an
explicit operator-controlled `--config` when using a model from another
project's directory.

Parse stdout as JSON. Diagnostics and patch previews use stderr. In a scan
report expect `schemaVersion: 1`, `target`, `createdAt`, `stack`,
`filesScanned`, `coverage`, `summary`, `findings` and `priority`. Read the scope
notes and identify skipped checks. Use the ID from the current report, since
ordinals depend on its sorted findings.

- `summary.counts` has `critical`, `high`, `medium` and `low`. `summary.health`
  is an integer out of 100.
- `findings[]` has `id`, `rule`, `category`, `severity`, `title`, `evidence`,
  `impact` and `advice`. Source findings may have `file` and a one-based `line`.
  Browser findings may have `url`, `viewport`, `selector` and a relative PNG
  `screenshot`.
- ID prefixes are `ERR`, `SEC`, `PERF`, `UI`, `BUG` and `SPEC`. Use `priority`
  to locate up to five findings for the initial summary. Keep the report and
  relative screenshot directory together.

## Request a fix

```bash
finding_id=$(node -p "require('./reports/agent/input.json').findings.find(f => f.rule === 'security.target-blank').id")
node dist/cli.js fix --path demo-app --report reports/agent/input.json \
  --out reports/agent --ids "$finding_id" --dry-run --no-llm --json
```

`fix --json` returns `{ "schemaVersion": 1, "results": [...] }`. Each result has
the report ID, a status and an optional detail. Follow the user's requested
mode. Default `patch` creates reviewable local artifacts. `interactive` requires
an actual terminal and per-patch approval. `pr` can create a commit, push a
branch and open a draft PR after approval. Use `--yes` only for an authorized PR
action. A dirty tree requires explicit `--force` to proceed. Do not
automatically choose it on failure.

| Status                  | Meaning                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `DRY_RUN`               | Candidate passed applicable verification in a copy. The diff was previewed                                              |
| `DRY_RUN_UNVERIFIED`    | Dry-run preview completed with project commands pending                                                                 |
| `PATCH_CREATED`         | A verified patch file is available at the reported path                                                                 |
| `PATCH_UNVERIFIED`      | A patch was saved. Project commands require trusted mode                                                                |
| `APPLIED`               | The user accepted the verified patch in the interactive terminal                                                        |
| `SKIPPED`               | No applicable candidate, stale evidence, unsupported file, or declined change. Read the detail                          |
| `FIX_FAILED (Rollback)` | This change failed verification or application. Report its ID and reason. Prior accepted changes have their own results |
| `PR_CREATED`            | A draft PR was created. The detail includes its URL                                                                     |
| `PR_FALLBACK`           | Publication could not finish. The detail states whether a local branch or pushed branch exists                          |

## Interpret process exit codes

| Code | Interpretation                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------- |
| `0`  | Command completed. Inspect coverage and per-finding statuses, including unverified or skipped work   |
| `1`  | Command error, failed fix, or an unavailable requested browser scan. A partial scan report may exist |
| `2`  | `scan --fail-on-critical` found at least one critical finding                                        |

Preserve the exit code when piping or redirecting output. In a user summary,
cite the report path, coverage, the finding IDs that matter, and the precise
verification or publication result. [Checked-in demo outputs](examples/demo/)
