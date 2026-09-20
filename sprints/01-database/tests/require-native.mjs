if (!process.env.YMPHARMA_TEST_DATABASE_URL || process.env.YMPHARMA_DISPOSABLE_TEST_DB !== 'yes') {
  throw new Error('Native PostgreSQL tests require YMPHARMA_TEST_DATABASE_URL and YMPHARMA_DISPOSABLE_TEST_DB=yes. They must not silently fall back to PGlite.');
}
