// Disposable real Auth/PostgREST acceptance stack. Never accepts a remote target.
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import {
  dockerReady,
  run,
  localEnvironment,
  pg,
  root,
  redact,
} from "./local-support.mjs";
import { join } from "node:path";
import { execFile } from "node:child_process";

const containers = [];
const network = `ym-assistant-${randomUUID()}`;
let networkCreated = false,
  proxy,
  db;
const password = randomBytes(32).toString("hex");
const jwtSecret = randomBytes(48).toString("base64url");
const publishable = `sb_publishable_${randomBytes(24).toString("base64url")}`;
const secret = `sb_secret_${randomBytes(24).toString("base64url")}`;
function jwt(role) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role, iss: "supabase", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  return `${body}.${createHmac("sha256", jwtSecret).update(body).digest("base64url")}`;
}
async function container(name, image, port, environment) {
  const id = await run(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      `${network}-${name}`,
      "--network",
      network,
      "--label",
      "com.ympharma.disposable-test=true",
      "--publish",
      `127.0.0.1::${port}`,
      ...Object.keys(environment).flatMap((key) => ["--env", key]),
      image,
    ],
    {
      env: { ...localEnvironment(), ...environment },
      timeout: 180000,
      inputLabel: `Start test ${name}`,
    },
  );
  if (!/^[a-f0-9]{64}$/.test(id))
    throw new Error("Invalid test container identity");
  containers.push(id);
  let address;
  try {
    address = await run("docker", ["port", id, `${port}/tcp`]);
  } catch {
    const logs = await new Promise((resolve) =>
      execFile(
        "docker",
        ["logs", id],
        { timeout: 5000 },
        (_error, stdout, stderr) => resolve(stdout + stderr),
      ),
    );
    throw new Error(
      `${name}: ${redact(logs).replaceAll(password, "[hidden]").replaceAll(jwtSecret, "[hidden]")}`,
    );
  }
  if (!/^127\.0\.0\.1:\d+$/.test(address))
    throw new Error("Non-loopback test binding");
  return { id, address };
}
async function ready(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await delay(500);
  }
  throw new Error("Local test service readiness timeout");
}
try {
  if (process.argv.length !== 2)
    throw new Error("This command accepts no targets or overrides");
  await dockerReady();
  await run("docker", ["network", "create", network]);
  networkCreated = true;
  const postgres = await container("db", "postgres:16", 5432, {
    POSTGRES_PASSWORD: password,
    POSTGRES_DB: "ympharma_test",
  });
  for (let i = 0; i < 60; i++) {
    try {
      await run(
        "docker",
        [
          "exec",
          postgres.id,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
          "-d",
          "ympharma_test",
        ],
        { timeout: 2000 },
      );
      break;
    } catch {
      if (i === 59) throw new Error("Local database readiness timeout");
      await delay(500);
    }
  }
  const dsn = `postgresql://postgres:${password}@${postgres.address}/ympharma_test`;
  const internalDsn = `postgresql://postgres:${password}@${network}-db:5432/ympharma_test?sslmode=disable`;
  db = new (pg().Client)({
    connectionString: dsn,
    connectionTimeoutMillis: 10000,
  });
  await db.connect();
  await db.query("create schema auth");
  await db.query("alter role postgres set search_path=auth,public");
  const auth = await container("auth", "supabase/gotrue:v2.196.0", 9999, {
    GOTRUE_API_HOST: "0.0.0.0",
    GOTRUE_API_PORT: "9999",
    API_EXTERNAL_URL: "http://localhost",
    GOTRUE_DB_DRIVER: "postgres",
    GOTRUE_DB_DATABASE_URL: internalDsn,
    GOTRUE_SITE_URL: "http://localhost",
    GOTRUE_JWT_SECRET: jwtSecret,
    GOTRUE_JWT_AUD: "authenticated",
    GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
    GOTRUE_JWT_ADMIN_ROLES: "service_role",
    GOTRUE_JWT_EXP: "3600",
    GOTRUE_DISABLE_SIGNUP: "true",
    GOTRUE_EXTERNAL_EMAIL_ENABLED: "true",
    GOTRUE_MAILER_AUTOCONFIRM: "true",
  });
  await ready(`http://${auth.address}/health`);
  process.env.YMPHARMA_TEST_DATABASE_URL = dsn;
  process.env.YMPHARMA_DISPOSABLE_TEST_DB = "yes";
  const { openDatabase, migrate, fixture } =
    await import("../sprints/01-database/tests/harness.mjs");
  const harness = await openDatabase();
  let f;
  try {
    await migrate(harness);
    f = await fixture(harness);
  } finally {
    await harness.close();
  }
  // Actual PostgREST supplies the JWT claims JSON, unlike the unit-test SQL stub.
  await db.query(`create or replace function auth.uid() returns uuid language sql stable as $$
 select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
 nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$`);
  const rest = await container("rest", "postgrest/postgrest:v14.17", 3000, {
    PGRST_DB_URI: internalDsn,
    PGRST_DB_SCHEMAS: "ym_api",
    PGRST_DB_ANON_ROLE: "anon",
    PGRST_JWT_SECRET: jwtSecret,
  });
  // Tiny loopback-only key gateway for these disposable services. No production secrets.
  proxy = createServer(async (req, res) => {
    try {
      const key = req.headers.apikey;
      if (key !== publishable && key !== secret) {
        res.writeHead(401).end();
        return;
      }
      const isAuth = req.url.startsWith("/auth/v1/"),
        isRest = req.url.startsWith("/rest/v1/");
      if (!isAuth && !isRest) {
        res.writeHead(404).end();
        return;
      }
      const prefix = isAuth ? "/auth/v1" : "/rest/v1";
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (
          v &&
          !["host", "connection", "content-length", "apikey"].includes(k)
        )
          headers.set(k, String(v));
      if (key === secret)
        headers.set("authorization", `Bearer ${jwt("service_role")}`);
      else if (
        !headers.has("authorization") ||
        headers.get("authorization") === `Bearer ${publishable}`
      )
        headers.set("authorization", `Bearer ${jwt("anon")}`);
      const parts = [];
      for await (const part of req) parts.push(part);
      const upstream = await fetch(
        `http://${isAuth ? auth.address : rest.address}${req.url.slice(prefix.length)}`,
        {
          method: req.method,
          headers,
          body: parts.length ? Buffer.concat(parts) : undefined,
          signal: AbortSignal.timeout(10000),
        },
      );
      res.writeHead(upstream.status, {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.writeHead(502).end();
    }
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const api = `http://127.0.0.1:${proxy.address().port}`;
  const options = {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  };
  const admin = createClient(api, secret, options);
  const accounts = {};
  for (const role of [
    "owner",
    "manager",
    "accountant",
    "cashier",
    "pharmacist",
    "inventory",
    "outsider",
  ]) {
    const email = `${role}@assistant.local.test`,
      pass = randomBytes(24).toString("base64url");
    const created = await admin.auth.admin.createUser({
      email,
      password: pass,
      email_confirm: true,
    });
    if (created.error || !created.data.user)
      throw new Error(
        `Test ${role} creation failed (${created.error?.status})`,
      );
    await db.query(
      "update ym.members set user_id=$1 where org_id=$2 and user_id=$3",
      [created.data.user.id, f.org, f[role]],
    );
    f[role] = created.data.user.id;
    const client = createClient(api, publishable, options);
    const signed = await client.auth.signInWithPassword({
      email,
      password: pass,
    });
    if (signed.error || !signed.data.session)
      throw new Error(`Test ${role} sign-in failed`);
    accounts[role] = { id: f[role], session: signed.data.session };
  }
  console.log(
    "Real Auth sign-in passed for seven isolated synthetic accounts.",
  );
  // Prepare stock through the same RPC available to the inventory employee.
  const inventory = createClient(api, publishable, options);
  await inventory.auth.setSession(accounts.inventory.session);
  let purchase;
  const purchaseRequest = randomUUID();
  for (let i = 0; i < 20; i++) {
    purchase = await inventory.schema("ym_api").rpc("receive_purchase_order", {
      p_org: f.org,
      p_request: purchaseRequest,
      p_warehouse: f.warehouse,
      p_supplier: f.supplier,
      p_reference: "ASSISTANT-TRAINING",
      p_items: [
        {
          unit_id: f.unit,
          quantity: 10,
          unit_cost: 4,
          batch_number: "TRAINING",
          expiry_date: "2099-12-31",
        },
      ],
    });
    if (!purchase.error) break;
    if (i === 19)
      throw new Error(`Training receipt failed (${purchase.error.code})`);
    await delay(500);
  }
  console.log(
    await run(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        "vitest.integration.config.mts",
      ],
      {
        timeout: 120000,
        inputLabel: "Real Auth/PostgREST assistant acceptance",
        env: {
          ...localEnvironment(),
          NEXT_PUBLIC_SUPABASE_URL: api,
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishable,
          YMPHARMA_SMOKE_CONTEXT: JSON.stringify({
            org: f.org,
            warehouse: f.warehouse,
            unit: f.unit,
            accounts,
          }),
        },
      },
    ),
  );
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
} finally {
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
  if (db) await db.end().catch(() => {});
  for (const id of containers.reverse())
    await run("docker", ["rm", "--force", id], { timeout: 30000 }).catch(() => {
      process.exitCode = 1;
    });
  if (networkCreated)
    await run("docker", ["network", "rm", network], { timeout: 30000 }).catch(
      () => {
        process.exitCode = 1;
      },
    );
}
