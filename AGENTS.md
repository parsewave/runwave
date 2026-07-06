# AGENTS.md

## Test Layout

- `runwave/agent/test`: tests for agent parsing, model response handling, prompts, and the agent playtest loop.
- `runwave/controller/test`: tests for browser/session control, recording args, profiling, and controller cleanup behavior.
- `runwave/protocol/test`: tests for shared action schema constants and mark-grid helpers.
- `stress-test/test`: tests for orchestration, remote runner setup, process cleanup, and container args.
- `runwave/test`: top-level `runwave` API and CLI tests, plus shared fixtures.

## Test Commands

Run all tests:

```sh
npm run test:all
```

Run all JavaScript tests:

```sh
npm test
```

Run package-specific JavaScript tests:

```sh
npm run test:agent
npm run test:controller
npm run test:stress-test
```

Run top-level `runwave` tests:

```sh
npm run test:runwave
```

Run the smoke test only:

```sh
npm run test:smoke
```

Run Python package tests:

```sh
npm run test:py
```
