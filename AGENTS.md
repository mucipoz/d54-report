# D54 Report repository instructions

Use the CLI contract for requests to scan a target, interpret its findings,
generate patches or open a draft PR. Start with the requested source directory,
repository or URL. A local source-only example from this checkout is shown
below. [Agent command contract and exit codes](AGENT.md)

```bash
node dist/cli.js scan --path demo-app --no-browser --no-llm --json
```

For implementation work, the CLI entry point is `src/cli.ts`, orchestration
lives in `src/engine.ts`, and the report schema lives in `src/types.ts`. Keep
machine-readable stdout usable and direct diagnostics to stderr. Use the
repository's declared build, typecheck and test scripts when authorized.
[Setup](README.md)
