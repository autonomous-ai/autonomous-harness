# Security

## Reporting a vulnerability

**Do not open a GitHub issue.** Issues are public, and a report filed there is disclosure.

Email **security@autonomous.ai** with enough detail to reproduce. We will acknowledge within three
working days and keep you updated until it is resolved. If you would like credit in the fix, say so.

## In scope

The spec and both packages in this repository — in particular anything that lets a provider's output
reach a client it should not, or a credential appear where it should not.

## Not a vulnerability

**`example-provider` runs `claude` with `--dangerously-skip-permissions`.** It executes tools without
asking, inside the directory it is configured with. That is deliberate and documented at the top of
its README: it exists to demonstrate a real agent, not to be deployed. Point it at a scratch
directory.

## For implementers

Two obligations in the profile are security-relevant, and both are easy to get subtly wrong:

- **HP-012** — a credential identifies **one** tenant. It must not reach another tenant's data through
  any method, including the extensions.
- **HP-903** — do not log or forward the credential beyond authenticating the request.

On our side, everything a provider sends is treated as untrusted input: validated, allowlisted, and
dropped if it is neither. Do not rely on being able to inject arbitrary client-side structures — you
cannot, and a stream that keeps trying is closed.
