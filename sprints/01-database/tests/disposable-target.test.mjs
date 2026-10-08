import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { disposableTarget } from './disposable-target.mjs';

test('destructive test target rejects parser overrides before any client exists', () => {
  for (const suffix of ['?host=remote.invalid', '?host=%2Fvar%2Frun', '?port=9999', '?dbname=production', '#fragment']) {
    assert.throws(() => disposableTarget(`postgres://localhost/ympharma_test${suffix}`, 'yes'));
  }
  for (const url of ['https://localhost/ympharma_test', 'postgres://remote.invalid/ympharma_test', 'postgres://localhost/production']) {
    assert.throws(() => disposableTarget(url, 'yes'));
  }
  assert.throws(() => disposableTarget('postgres://localhost/ympharma_test', 'no'));
});

test('driver receives exactly the validated loopback destination', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const options = disposableTarget(`postgres://review:p%40ss@${host}:5439/ympharma_test`, 'yes');
    const client = new pg.Client(options); // No connect; test pg parsing only.
    assert.equal(client.host, host === '[::1]' ? '::1' : host);
    assert.equal(client.port, 5439);
    assert.equal(client.database, 'ympharma_test');
    assert.equal(client.password, 'p@ss');
    assert.equal(client.ssl, false);
  }
});
