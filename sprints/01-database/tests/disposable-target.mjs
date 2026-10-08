export function disposableTarget(value, acknowledgement) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/ympharma_test' || url.search || url.hash || acknowledgement !== 'yes') {
    throw new Error('Tests require an explicitly disposable localhost /ympharma_test database without query overrides.');
  }
  // Never forward connection-string options interpreted differently by pg.
  // Set every destination component explicitly so PGHOST/PGDATABASE cannot override it.
  return {
    host: url.hostname === '[::1]' ? '::1' : url.hostname,
    port: Number(url.port || 5432), database: 'ympharma_test',
    user: decodeURIComponent(url.username || 'postgres'),
    password: decodeURIComponent(url.password),
    ssl: false, connectionTimeoutMillis: 10000,
  };
}
