# 4evergent Operator CLI

`4evergent` is a command-line operator client for the 4evergent HTTP API. It is
an operator tool only — it does NOT sign transactions, build Stellar operations,
or access Horizon directly. All transaction work is delegated to the API server.

## Install

```bash
npm install --global @4evergent/cli
4evergent --help
```

The published package includes its built CLI and installs the `4evergent`
command. To run the source version while developing this repository, install
the workspace dependencies and use `pnpm --filter @4evergent/cli build`.

## Version

Run `4evergent --version` or `4evergent -v` to print the CLI package version and
exit successfully. This works offline and does not require API configuration.
The build embeds the version from `apps/cli/package.json`; source runs read the
same package metadata.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `FOREGENT_API_URL` | `http://127.0.0.1:3000` | API base URL |
| `FOREGENT_API_KEY` | - | Bearer API key (production auth mode) |

```bash
export FOREGENT_API_URL=http://localhost:3000
export FOREGENT_API_KEY=your-api-key-here
```

Set these variables in the same shell before invoking `4evergent`; the API key
is read from the environment and is never saved by the CLI. `FOREGENT_API_KEY`
is optional when the API is running in development authentication mode.

## Commands

```
4evergent health                           Check API health
4evergent agent list                        List your agents
4evergent agent get <id>                    Show agent details
4evergent agent pause <id>                  Pause agent (rejects new intents)
4evergent agent resume <id>                 Resume agent (active)
4evergent agent disable <id>                Disable agent
4evergent approval list                     List pending approvals
4evergent approval approve <id>             Approve an intent
4evergent approval reject <id>              Reject an intent
4evergent execution list                    List executions across all agents
4evergent execution get <id>                Show execution detail
4evergent execution retry <id>              Retry a failed or dead-letter execution
4evergent execution cancel <id>             Cancel a queued or executing execution
4evergent policy get <agent-id>             Show effective policy rules
4evergent activity list <agent-id> [limit]  List agent activity (limit 1-100, default 50)
4evergent schedule list <agent-id> [limit]  List agent schedules (limit 1-100, default 50)
4evergent schedule get <agent-id> <sch-id>  Show schedule detail
4evergent intent submit <agent-id> <type> [args...] [--idempotency-key <key>]
                                            Submit an intent (see Intent types below)
```

## Intent submission

Supported intent types (accepted by the transaction pipeline):

```
payment       <asset> <amount> <destination> <reason> [memo]
trustline     <assetCode> <issuer> <reason> [limit]
contract_call <contractId> <function> <args-json-array> <reason>
```

`account_settings` is NOT supported by the transaction pipeline and is
rejected by the CLI.

The server decides the outcome: policy `allow` executes directly,
`requires_approval` returns an approvalId (approve it later with
`4evergent approval approve`), `deny` is rejected with 403.

### Idempotency

Use `--idempotency-key <key>` to make submissions safe against network
timeouts: the same key + same intent returns the original result instead
of creating a duplicate (HTTP 200), and the same key with a different
intent is rejected with 409.

If the CLI reports a network failure, the request outcome is UNKNOWN —
the request may have reached the server. Retry manually with the SAME
`--idempotency-key`. The CLI never retries automatically and never
submits twice silently.

## Examples

```bash
4evergent health
4evergent agent list
4evergent agent pause agent-123
4evergent approval list
4evergent approval approve ap-123
4evergent execution list
4evergent execution get exec-123
4evergent execution retry exec-123
4evergent execution cancel exec-123
4evergent policy get agent-123
4evergent activity list agent-123
4evergent activity list agent-123 10
4evergent schedule list agent-123
4evergent schedule get agent-123 sch-123
4evergent intent submit agent-123 payment XLM 25 GDAAAA... "weekly payout"
4evergent intent submit agent-123 payment XLM 25 GDAAAA... "weekly payout" --idempotency-key weekly-42
4evergent intent submit agent-123 trustline USDC GDAAAA... "add USDC trustline" 1000
4evergent intent submit agent-123 contract_call CABCD... transfer '["arg1","arg2"]' "transfer funds"
```

## Output

Default output is human-readable. Every command exits `0` on success,
non-zero on failure (network error, HTTP 4xx/5xx). The `--json` flag is
not yet supported — planned for a future CLI phase.

## Security

- **Never stores credentials.** API key is read from the environment on each run.
- **Never prints secrets.** API keys, XDR blobs, and private keys never appear in output.
- **No direct Stellar access.** The CLI only makes HTTP calls to the configured API.
- **No mainnet support.** The API itself rejects non-testnet Horizon URLs.
- The API key is sent as `Authorization: Bearer <key>` on every request when set.
