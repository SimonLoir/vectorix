# Reproducible dependency patches

`@pixeldrive/prisma-zod-generator@2.1.4` receives Prisma BigInt defaults as decimal strings and otherwise emits `z.bigint().default("0")`. The narrow model-generator patch emits a bigint literal instead. Native Prisma defaults and migration schema parity remain unchanged; ignored generated clients/schemas are never edited by hand.

pnpm applies the locked patch during installation. All five service Dockerfiles copy `patches/` before their frozen dependency install. `packages/db/tests/bigint-defaults.test.ts`, included in the API regression command, exercises the generated zero defaults and rejects accidental string coercion. Reassess this patch when upgrading the generator.
