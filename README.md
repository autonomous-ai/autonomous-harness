# Autonomous Harness

The [Autonomous Harness](https://www.autonomous.ai/harness) is a device and a service for running
coding agents: one sentence, spoken to a disc on your desk, dispatched to the agents already running
on your laptop, your server, and in the cloud.

https://github.com/user-attachments/assets/97848065-61c6-40df-be66-a8247f69aa4c

This repository is where the parts other people need to build against are published — specs,
reference implementations, and the tools to check your own work against them.

| | |
|---|---|
| [`provider/`](provider/README.md) | **Provider protocol** — make your own agent platform available on the Harness. Users connect it with a URL and a credential, then drive it from the web app or the device. A profile of [A2A](https://github.com/a2aproject/A2A) v1.0.1, with a reference implementation and a conformance runner |

More will be published here as it stabilises. Each section is self-contained: its own README, its own
packages, its own tests.

## Getting started

Every section stands on its own — start with its README. For the provider protocol:

```bash
cd provider/reference-provider && npm install && npm run dev
npm run conformance -- --url https://your-endpoint --key <credential>
```

## Conventions across this repository

- **Specs are numbered.** Every normative statement has a stable id, so a failure can point at a
  clause rather than a symptom, and a conformance runner can assert one check per id.
- **Specs are compatibility contracts.** Optional fields may be added; nothing published is renamed,
  removed, retyped or reinterpreted without a new revision served alongside the old one.
- **Reference implementations carry no runtime dependencies.** You should be able to read one end to
  end and know what your own implementation has to do, without installing anything to understand it.

## Contributing, security, licence

- Gaps in a spec, or a clause its runner cannot actually verify, are the most useful thing to report —
  see [CONTRIBUTING.md](CONTRIBUTING.md).
- Security reports: **not the issue tracker** — see [SECURITY.md](SECURITY.md).
- Licensed under [Apache-2.0](LICENSE).
