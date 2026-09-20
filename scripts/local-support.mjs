import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { access, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const workdir = join(root, "sprints/01-database");
export const project = "ympharma-local-review";
export const network = `${project}-loopback`;
export const org = "00000000-0000-4000-8000-000000000501";
export const roles = [
  "owner",
  "manager",
  "accountant",
  "cashier",
  "pharmacist",
  "inventory",
];
export const stateFile = join(root, ".local/training-accounts.json");
export const pg = () => createRequire(join(workdir, "package.json"))("pg");
const exec = promisify(execFile);

export function localEnvironment(source = process.env) {
  // CLI config also accepts environment overrides. Do not inherit hosted settings.
  const env = Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !key.startsWith("SUPABASE_") &&
        !key.startsWith("NEXT_PUBLIC_SUPABASE_"),
    ),
  );
  return { ...env, SUPABASE_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" };
}

export function redact(text) {
  return String(text)
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, "[database URL hidden]")
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[key hidden]")
    .replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      "[token hidden]",
    );
}

export async function run(
  file,
  args,
  {
    env = localEnvironment(),
    timeout = 120000,
    inputLabel = "Command",
    ...options
  } = {},
) {
  try {
    return (
      await exec(file, args, {
        cwd: root,
        env,
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        ...options,
      })
    ).stdout.trim();
  } catch (error) {
    // execFile errors include arguments and output; never echo the raw error.
    const detail =
      error.code === "ENOENT"
        ? "executable not installed"
        : redact(error.stderr || "failed or timed out");
    throw new Error(`${inputLabel}: ${detail.slice(-1600)}`);
  }
}

export function assertLocalUrl(
  value,
  { database = false, dbName = "postgres" } = {},
) {
  if (typeof value !== "string")
    throw new Error("Local service URL is missing.");
  const u = new URL(value);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.search ||
    u.hash
  )
    throw new Error(
      "Only explicit loopback service URLs without query overrides are allowed.",
    );
  if (database) {
    if (
      !["postgres:", "postgresql:"].includes(u.protocol) ||
      u.pathname !== `/${dbName}` ||
      !u.port
    )
      throw new Error("Unexpected local database target.");
  } else if (
    u.protocol !== "http:" ||
    u.port !== "54321" ||
    u.username ||
    u.password ||
    u.pathname !== "/"
  ) {
    throw new Error("Expected the local API at http://127.0.0.1:54321.");
  }
  return u;
}

export function parseStatus(raw) {
  const s = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (s.linked || s.linked_project_ref)
    throw new Error("Hosted project links are not accepted by local tooling.");
  const api = assertLocalUrl(s.API_URL);
  const db = assertLocalUrl(s.DB_URL, { database: true });
  if (db.port !== "54322")
    throw new Error("Unexpected local Supabase database port.");
  if (
    typeof s.PUBLISHABLE_KEY !== "string" ||
    !/^sb_publishable_[A-Za-z0-9_-]+$/.test(s.PUBLISHABLE_KEY)
  )
    throw new Error(
      "CLI did not return a publishable key. Install the pinned CLI; do not use service_role in the browser.",
    );
  return {
    api: api.origin,
    db: db.toString(),
    publishable: s.PUBLISHABLE_KEY,
    secret: s.SECRET_KEY,
  };
}

export function browserEnv(s) {
  assertLocalUrl(s.api);
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(s.publishable))
    throw new Error("Invalid public key.");
  return `# YmPharma local review: browser-safe values only\nNEXT_PUBLIC_SUPABASE_URL=${s.api}\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${s.publishable}\n`;
}

export async function writeBrowserEnv(s, path = join(root, ".env.local")) {
  const text = browserEnv(s);
  try {
    await writeFile(path, text, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if ((await readFile(path, "utf8")) !== text)
      throw new Error(
        "Existing .env.local was preserved. Use npm run local:dev to supply local public settings without overwriting it.",
      );
  }
}

export function assertDockerEndpoint(value) {
  if (!value?.startsWith("unix://") && !value?.startsWith("npipe://"))
    throw new Error(
      "Use local Docker Desktop/Linux containers; remote Docker endpoints are not allowed.",
    );
}

export function assertBindings(containers) {
  for (const c of containers) {
    for (const bindings of Object.values(c.NetworkSettings?.Ports ?? {})) {
      for (const binding of bindings ?? []) {
        if (!["127.0.0.1", "::1"].includes(binding.HostIp))
          throw new Error(
            "A review container exposes a non-loopback port. Stop the review stack before continuing.",
          );
      }
    }
  }
}

export async function guardProject() {
  for (const name of ["project-ref"]) {
    try {
      await access(join(workdir, "supabase/.temp", name));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(
      "This review workdir is linked to a hosted project. Use an unlinked local checkout.",
    );
  }
  const config = await readFile(join(workdir, "supabase/config.toml"), "utf8");
  if (!config.includes(`project_id = "${project}"`))
    throw new Error("Unexpected review project ID.");
  // The CLI automatically loads .env from its workdir. Refuse hidden overrides.
  try {
    await access(join(workdir, ".env"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    "Remove the review workdir .env overrides before using local tooling.",
  );
}

export async function dockerReady() {
  let endpoint = process.env.DOCKER_HOST;
  if (!endpoint) {
    const ctx = JSON.parse(
      await run("docker", ["context", "inspect"], {
        inputLabel: "Docker context",
      }),
    );
    endpoint = ctx[0]?.Endpoints?.docker?.Host;
  }
  assertDockerEndpoint(endpoint);
  const info = JSON.parse(
    await run("docker", ["info", "--format", "{{json .}}"], {
      inputLabel: "Docker Desktop (start Linux containers)",
    }),
  );
  if (info.OSType !== "linux")
    throw new Error("Switch Docker Desktop to Linux containers.");
}

export const cli = (args, options) =>
  run(
    process.execPath,
    [
      join(root, "node_modules/supabase/dist/supabase.js"),
      ...args,
      "--workdir",
      workdir,
    ],
    { inputLabel: "Supabase CLI", cwd: workdir, ...options },
  );

export async function status() {
  await guardProject();
  await dockerReady();
  const s = parseStatus(await cli(["status", "-o", "json"]));
  const ids = await run("docker", [
    "ps",
    "-q",
    "--filter",
    `label=com.supabase.cli.project=${project}`,
  ]);
  if (!ids) throw new Error("No running containers for the review project.");
  assertBindings(
    JSON.parse(await run("docker", ["inspect", ...ids.split(/\s+/)])),
  );
  return s;
}

export async function ensureNetwork() {
  const names = await run("docker", ["network", "ls", "--format", "{{.Name}}"]);
  if (!names.split(/\r?\n/).includes(network))
    await run("docker", [
      "network",
      "create",
      "--driver",
      "bridge",
      "-o",
      "com.docker.network.bridge.host_binding_ipv4=127.0.0.1",
      network,
    ]);
  const [n] = JSON.parse(await run("docker", ["network", "inspect", network]));
  if (
    n.Driver !== "bridge" ||
    n.Options?.["com.docker.network.bridge.host_binding_ipv4"] !== "127.0.0.1"
  )
    throw new Error(
      "The named review network must bind published ports to 127.0.0.1.",
    );
}

export function assertReset(args) {
  if (args.length !== 1 || args[0] !== "--confirm-local-data-loss")
    throw new Error(
      "Reset deletes review data and Auth users. Explicitly use: npm run local:reset -- --confirm-local-data-loss",
    );
}

export function assertTrainingState(state) {
  if (
    state?.project !== project ||
    state?.organization !== org ||
    state?.version !== 1 ||
    !Array.isArray(state.accounts) ||
    state.accounts.length !== roles.length
  )
    throw new Error("Invalid local training state.");
  for (const role of roles) {
    const a = state.accounts.find((account) => account.role === role);
    if (
      !a ||
      a.email !== `${role}@local.ympharma.test` ||
      typeof a.password !== "string" ||
      a.password.length < 24
    )
      throw new Error("Invalid local training account.");
  }
  return state;
}
