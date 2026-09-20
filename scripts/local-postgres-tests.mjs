import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import {
  root,
  workdir,
  dockerReady,
  run,
  localEnvironment,
  redact,
} from "./local-support.mjs";

let container;
let interrupted = false;
let failure = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = true;
  });
try {
  if (process.argv.length !== 2)
    throw new Error("No database URLs or target overrides accepted.");
  await dockerReady();
  const password = randomBytes(32).toString("base64url");
  const env = { ...localEnvironment(), POSTGRES_PASSWORD: password };
  console.log(
    "Creating a temporary PostgreSQL 16 container for destructive tests; the application stack is not used.",
  );
  container = await run(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      `ympharma-test-${randomUUID()}`,
      "--label",
      "com.ympharma.disposable-test=true",
      "--env",
      "POSTGRES_PASSWORD",
      "--env",
      "POSTGRES_DB=ympharma_test",
      "--publish",
      "127.0.0.1::5432",
      "postgres:16",
    ],
    { env, timeout: 600000 },
  );
  if (!/^[a-f0-9]{64}$/.test(container)) {
    container = null;
    throw new Error("Docker did not return a valid container ID.");
  }
  let ready = false;
  for (let attempt = 0; attempt < 60 && !interrupted; attempt++) {
    try {
      await run(
        "docker",
        [
          "exec",
          container,
          "pg_isready",
          "-U",
          "postgres",
          "-d",
          "ympharma_test",
        ],
        { timeout: 5000 },
      );
      ready = true;
      break;
    } catch {
      await setTimeout(500);
    }
  }
  if (!ready || interrupted)
    throw new Error(
      "Temporary PostgreSQL was not ready or execution was interrupted.",
    );
  const port = await run("docker", ["port", container, "5432/tcp"]);
  if (!/^127\.0\.0\.1:\d+$/.test(port))
    throw new Error("Unexpected container port binding.");
  const output = await run(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      "tests/database.test.mjs",
      "tests/concurrency.test.mjs",
    ],
    {
      cwd: workdir,
      timeout: 300000,
      inputLabel: "Native PostgreSQL tests",
      env: {
        ...localEnvironment(),
        YMPHARMA_TEST_DATABASE_URL: `postgresql://postgres:${password}@${port}/ympharma_test`,
        YMPHARMA_DISPOSABLE_TEST_DB: "yes",
      },
    },
  );
  console.log(redact(output).replaceAll(password, "[password hidden]"));
} catch (error) {
  failure = true;
  console.error(error.message);
} finally {
  if (container) {
    try {
      await run("docker", ["stop", "--time", "2", container], { cwd: root });
    } catch {
      failure = true;
      console.error(
        "Could not remove the temporary container. Remove only the container with label com.ympharma.disposable-test=true.",
      );
    }
  }
  process.exitCode = failure || interrupted ? 1 : 0;
}
