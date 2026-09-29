import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Tests share one database, so files run one after another.
    fileParallelism: false,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://kankan:kankan@localhost:5433/kankan_test',
      NODE_ENV: 'test',
      // A fixed key for tests only (32 zero bytes).
      ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      UPLOADS_DIR: '/tmp/kanbanto-test-uploads',
      // The tests' fake S3 runs on this machine (the check that refuses such addresses has its own test).
      ALLOW_PRIVATE_BUCKETS: 'true',
    },
    hookTimeout: 30_000,
  },
})
