# Governance-Encoded Supervision Artifact

This private repository contains the bounded-core V3.1-R2 artifact,
test suite, and controlled execution evidence for a design science study
of supervisory governability in VAT e-invoicing.

## Repository structure

- `contracts/` — bounded-core Solidity artifact
- `test/` — controlled Node.js/TypeScript test suite
- `evidence/` — frozen Step 2C execution evidence package

## Execution environment

- Node.js 24.18.0
- npm 11.16.0
- Hardhat 3.11.1
- Solidity 0.8.28
- EVM target: Cancun

## Reproduction commands

    npm ci
    npx.cmd hardhat test
    npx.cmd hardhat test nodejs --coverage

## Controlled execution result

- 19 test cases completed successfully
- 99.23% line coverage
- 99.12% statement coverage

## Claim boundary

The execution supports controlled specification-execution conformance
and boundary-challenge observations only. It does not establish
institutional validity, legal correctness, performance superiority,
scalability, production readiness, or field effectiveness.

## Repository status

This repository is maintained privately during double-anonymized review.
The repository URL and owner identity must not appear in anonymized
manuscript or supplementary materials.
