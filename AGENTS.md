# AGENTS.md

## Test Layout

- `agent/test`: tests for agent parsing, model response handling, prompts, and the agent playtest loop.
- `controller/test`: tests for browser/session control, recording args, profiling, and controller cleanup behavior.
- `ops/test`: tests for orchestration, remote runner setup, process cleanup, and container args.
- `test`: root integration or cross-package tests, plus shared fixtures.

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
npm run test:ops
```

Run root integration/cross-package tests:

```sh
npm run test:integration
```

Run the smoke test only:

```sh
npm run test:smoke
```

Run Python package tests:

```sh
npm run test:py
```
