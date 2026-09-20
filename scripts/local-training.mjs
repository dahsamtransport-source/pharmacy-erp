import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { seedCatalog } from "./local-catalog.mjs";
import { ensureTrainingUser } from "./local-auth.mjs";
import { createClient } from "@supabase/supabase-js";
import {
  org,
  project,
  roles,
  stateFile,
  pg,
  assertTrainingState,
  assertLocalUrl,
} from "./local-support.mjs";

const client = (s, key = s.publishable) =>
  createClient(s.api, key, {
    db: { schema: "ym_api" },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
async function save(state) {
  const pending = `${stateFile}.tmp`;
  await writeFile(pending, JSON.stringify(state, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(pending, stateFile);
}

export async function seed(s) {
  assertLocalUrl(s.api);
  assertLocalUrl(s.db, { database: true });
  if (!/^sb_secret_[A-Za-z0-9_-]+$/.test(s.secret ?? ""))
    throw new Error("Local admin key unavailable; use the pinned CLI.");
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  const lock = `${dirname(stateFile)}/seed.lock`;
  try {
    await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch {
    throw new Error(
      "Another local seed may be running. Do not run two seed commands together.",
    );
  }
  const db = new (pg().Client)({ connectionString: s.db });
  try {
    await db.connect();
    const other = await db.query(
      "select id from ym.organizations where id<>$1 limit 1",
      [org],
    );
    if (other.rowCount)
      throw new Error(
        "Seeding is restricted to the dedicated training database; other organizations found.",
      );
    let state;
    try {
      state = assertTrainingState(
        JSON.parse(await readFile(stateFile, "utf8")),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = {
        version: 1,
        project,
        organization: org,
        notice:
          "SYNTHETIC LOCAL TRAINING ONLY. Do not upload or use these accounts in production.",
        accounts: roles.map((role) => ({
          role,
          email: `${role}@local.ympharma.test`,
          password: randomBytes(24).toString("base64url"),
        })),
        ids: Object.fromEntries(
          [
            "center",
            "warehouse",
            "product",
            "unit",
            "supplier",
            "customer",
          ].map((key) => [key, randomUUID()]),
        ),
      };
      await save(state); // Persist passwords before creating Auth users; interrupted runs can resume.
    }
    const admin = client(s, s.secret);
    for (const a of state.accounts) {
      a.id = await ensureTrainingUser(admin, client(s), a);
      await save(state);
    }
    await seedCatalog(db, state);
    console.log(
      "Training users and empty catalog are ready. Credentials are in .local/training-accounts.json on this device only.",
    );
    console.log(
      "No stock, invoices or financial success indicators were fabricated. Receive a training purchase, then sell it in the UI.",
    );
  } catch (error) {
    try {
      await db.query("rollback");
    } catch {
      /* Connection may not have opened. */
    }
    // Database errors can contain personal data; details remain out of console output.
    throw new Error(
      `Local seed did not complete (${error.code ?? error.message}). Training state is retained; no existing account was reset.`,
    );
  } finally {
    await db.end().catch(() => {});
    await rm(lock, { force: true });
  }
}

export async function smoke(s) {
  assertLocalUrl(s.api);
  const state = assertTrainingState(
    JSON.parse(await readFile(stateFile, "utf8")),
  );
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const anon = client(s);
  const anonymous = await anon.rpc("financial_report_options", { p_org: org });
  check(
    anonymous.error && ["42501", "PGRST301"].includes(anonymous.error.code),
    "Anonymous report access was not explicitly denied.",
  );
  let checks = 1;
  for (const a of state.accounts) {
    const c = client(s);
    try {
      const signed = await c.auth.signInWithPassword({
        email: a.email,
        password: a.password,
      });
      check(
        !signed.error && signed.data.user?.id === a.id,
        `Training ${a.role} sign-in failed.`,
      );
      checks++;
      const context = await c.rpc("workspace_context", {});
      check(
        !context.error &&
          context.data?.some((w) => w.id === org && w.role === a.role),
        `Training ${a.role} workspace/role mismatch.`,
      );
      checks++;
      const report = await c.rpc("financial_report_options", { p_org: org });
      if (["owner", "manager", "accountant"].includes(a.role))
        check(!report.error && report.data, `${a.role} finance access failed.`);
      else
        check(
          report.error?.code === "42501",
          `${a.role} finance access was not explicitly denied.`,
        );
      checks++;
      const hidden = await c.schema("ym").from("valuations").select("*");
      check(
        hidden.error?.code === "PGRST106",
        "Private cost schema must not be exposed through PostgREST.",
      );
      checks++;
    } finally {
      await c.auth.signOut({ scope: "local" });
    }
  }
  console.log(
    `${checks} local Auth/PostgREST assertions passed. No business records were changed.`,
  );
}
