# Capture a test charge with Acme

Install the Acme CLI, create a test charge, and confirm it was captured.

## Do this

1. Install the CLI: `brew install acme` on macOS and Linux.
2. Run `acme charges create --amount 500 --currency usd --capture`.

## Verify

Run `acme charges list --limit 1` and confirm the newest charge shows `captured: true`.
