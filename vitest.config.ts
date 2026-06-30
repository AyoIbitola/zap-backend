import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // Lightning tests require a separate test wallet — run explicitly via --reporter verbose
    exclude: ['tests/integration/lightning/**'],
    // Run test files sequentially to avoid DB lock contention between suites
    sequence: { concurrent: false },
    // Each test file gets a fresh module registry (important for vi.mock to isolate state)
    isolate: true,
    // Cloud Postgres + Redis connections add latency; bcrypt login tests require >5s for 11 calls
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
