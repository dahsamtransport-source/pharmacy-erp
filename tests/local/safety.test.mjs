import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseStatus,
  assertLocalUrl,
  browserEnv,
  writeBrowserEnv,
  assertBindings,
  assertReset,
  assertDockerEndpoint,
  assertTrainingState,
  localEnvironment,
  redact,
  project,
  roles,
  org,
} from "../../scripts/local-support.mjs";

const statusFixture = () => ({
  API_URL: "http://127.0.0.1:54321",
  DB_URL: "postgresql://postgres:localpassword@127.0.0.1:54322/postgres",
  PUBLISHABLE_KEY: "sb_publishable_unit_fixture",
  SECRET_KEY: "sb_secret_never_emit",
});

test("parses the pinned CLI JSON format and exports only browser-safe values", () => {
  const parsed = parseStatus(JSON.stringify(statusFixture()));
  const exported = browserEnv(parsed);
  assert.match(
    exported,
    /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_/,
  );
  for (const forbidden of [
    "sb_secret_",
    "localpassword",
    "DB_URL",
    "SERVICE_ROLE",
  ])
    assert.ok(!exported.includes(forbidden));
});
test("rejects hosted, tunneled, query-overridden and unexpected service targets", () => {
  for (const url of [
    "https://example.supabase.co",
    "http://127.0.0.1.evil.test:54321",
    "http://127.0.0.1:54321/rest/v1",
    "http://127.0.0.1:54321?host=example.com",
    "http://admin:secret@127.0.0.1:54321",
    "http://127.0.0.1:12345",
  ])
    assert.throws(() => assertLocalUrl(url));
  for (const DB_URL of [
    "postgres://admin:secret@db.example.com:5432/postgres",
    "postgres://postgres@127.0.0.1:54322/production",
    "postgres://postgres@127.0.0.1:54322/postgres?host=evil.test",
  ])
    assert.throws(() => parseStatus({ ...statusFixture(), DB_URL }));
});
test("rejects privileged and legacy keys rather than weakening the browser contract", () => {
  for (const key of [
    "sb_secret_example",
    "eyJabc.def.ghi",
    "sb_publishable_injected\nSECRET=oops",
    undefined,
  ])
    assert.throws(() =>
      parseStatus({ ...statusFixture(), PUBLISHABLE_KEY: key }),
    );
});
test("does not overwrite existing frontend configuration, and is repeatable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ympharma-env-"));
  try {
    const path = join(dir, ".env.local");
    const s = parseStatus(statusFixture());
    await writeBrowserEnv(s, path);
    await writeBrowserEnv(s, path);
    await writeFile(path, "EXISTING_SETTING=preserve\n");
    await assert.rejects(writeBrowserEnv(s, path), /preserved/);
    assert.equal(await readFile(path, "utf8"), "EXISTING_SETTING=preserve\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("CLI subprocesses do not inherit Supabase hosted overrides", () => {
  const clean = localEnvironment({
    PATH: "/bin",
    SUPABASE_ACCESS_TOKEN: "secret",
    SUPABASE_API_URL: "https://remote",
    SUPABASE_CLI_BINARY_OVERRIDE: "/evil",
    NEXT_PUBLIC_SUPABASE_URL: "remote",
  });
  assert.equal(clean.PATH, "/bin");
  assert.equal(clean.SUPABASE_ACCESS_TOKEN, undefined);
  assert.equal(clean.SUPABASE_API_URL, undefined);
  assert.equal(clean.SUPABASE_CLI_BINARY_OVERRIDE, undefined);
  assert.equal(clean.NEXT_PUBLIC_SUPABASE_URL, undefined);
});
test("requires local Docker engine sockets and loopback published ports", () => {
  assertDockerEndpoint("unix:///var/run/docker.sock");
  assertDockerEndpoint("npipe:////./pipe/docker_engine");
  for (const endpoint of [
    "tcp://127.0.0.1:2375",
    "ssh://remote",
    "https://remote",
    undefined,
  ])
    assert.throws(() => assertDockerEndpoint(endpoint));
  const container = (HostIp) => [
    {
      NetworkSettings: {
        Ports: { "5432/tcp": [{ HostIp, HostPort: "54322" }] },
      },
    },
  ];
  assertBindings(container("127.0.0.1"));
  assertBindings(container("::1"));
  for (const host of ["0.0.0.0", "::", "192.168.1.2"])
    assert.throws(() => assertBindings(container(host)));
});
test("reset demands an exact destructive acknowledgement and rejects target flags", () => {
  assertReset(["--confirm-local-data-loss"]);
  for (const args of [
    [],
    ["--yes"],
    ["--confirm-local-data-loss", "--linked"],
    ["--db-url", "remote"],
  ])
    assert.throws(() => assertReset(args));
});
test("redacts database URLs, API keys and JWTs from diagnostic messages", () => {
  const result = redact(
    "postgresql://postgres:password@localhost/db sb_secret_sensitive sb_publishable_example eyJhbGci.test.sig",
  );
  for (const secret of ["password", "sensitive", "example", "eyJ"])
    assert.ok(!result.includes(secret));
});
test("training state is restricted to the expected project and six synthetic roles", () => {
  const state = {
    version: 1,
    project,
    organization: org,
    accounts: roles.map((role) => ({
      role,
      email: `${role}@local.ympharma.test`,
      password: "a".repeat(32),
    })),
  };
  assertTrainingState(state);
  assert.throws(() => assertTrainingState({ ...state, project: "production" }));
  assert.throws(() =>
    assertTrainingState({ ...state, accounts: state.accounts.slice(1) }),
  );
  assert.throws(() =>
    assertTrainingState({
      ...state,
      accounts: state.accounts.map((a) => ({
        ...a,
        email: "real@example.com",
      })),
    }),
  );
});
