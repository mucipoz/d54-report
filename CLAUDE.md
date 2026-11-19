# D54 Report with Claude Code

Use Bash to invoke the installed `d54-report` command or the built
`dist/cli.js`. Read the CLI report as JSON and use its concrete file, line or
selector when explaining a finding. Claude Code can drive deterministic scans
without configuring an Anthropic API account. Configure the optional model
provider only when the operator wants a separate model call.
[Universal agent contract](AGENT.md) ·
[Model settings](README.md#model-bağlantısı)

```bash
node dist/cli.js scan --path demo-app --no-llm --no-browser --json
```

For a fix request, pass the local target and the resulting report to `fix`.
Return its per-finding status. Patch creation, interactive application and draft
PR publication have distinct outcomes and approval requirements.
[Fix modes](README.md#düzeltme)
