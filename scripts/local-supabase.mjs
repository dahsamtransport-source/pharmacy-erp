import { spawn } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  root,
  project,
  network,
  cli,
  status,
  guardProject,
  dockerReady,
  ensureNetwork,
  writeBrowserEnv,
  assertReset,
  localEnvironment,
} from "./local-support.mjs";

const [command, ...args] = process.argv.slice(2);
try {
  if (command !== "reset" && args.length)
    throw new Error(
      "Unexpected arguments. Hosted targets and URL overrides are not accepted.",
    );
  await guardProject();
  switch (command) {
    case "doctor":
      if (Number(process.versions.node.split(".")[0]) < 22)
        throw new Error("Install Node.js 22 or newer.");
      console.log(
        `Node.js ${process.versions.node}; Supabase CLI ${await cli(["--version"])}`,
      );
      await dockerReady();
      console.log(
        "Local Docker Linux engine is ready. Review migrations are isolated from legacy migrations.",
      );
      break;
    case "start":
      await dockerReady();
      await ensureNetwork();
      console.log(
        "Starting isolated local services. First use downloads Docker images; this may take several minutes.",
      );
      await cli(["start", "--network-id", network], { timeout: 1200000 });
      await status();
      console.log(
        "Local services are ready. Studio: http://127.0.0.1:54323. Run local:seed once, then local:dev.",
      );
      break;
    case "stop":
      await dockerReady();
      await cli(["stop", "--project-id", project]);
      console.log("Review services stopped; persistent local data retained.");
      break;
    case "status":
      await status();
      console.log(
        "Review stack is running on loopback. API: http://127.0.0.1:54321; Studio: http://127.0.0.1:54323. Keys hidden.",
      );
      break;
    case "env":
      await writeBrowserEnv(await status());
      console.log(
        "Browser-safe local configuration saved to .env.local. Restart/rebuild the frontend after changing configuration.",
      );
      break;
    case "migrate":
      await status();
      await cli(["migration", "up", "--local"]);
      console.log("Pending review migrations applied locally.");
      break;
    case "reset": {
      assertReset(args);
      await status();
      console.log(
        "Resetting only the disposable review stack, including local Auth users.",
      );
      await cli(["db", "reset", "--local", "--yes"], { timeout: 600000 });
      await mkdir(join(root, ".local"), { recursive: true });
      try {
        await rename(
          join(root, ".local/training-accounts.json"),
          join(root, `.local/accounts-before-reset-${Date.now()}.json`),
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await rm(join(root, ".local/seed.lock"), { force: true });
      console.log(
        "Local reset finished. Run local:seed to create new training users. Old credential file archived locally.",
      );
      break;
    }
    case "seed":
    case "smoke": {
      const s = await status();
      const tools = await import("./local-training.mjs");
      if (command === "seed") await tools.seed(s);
      else await tools.smoke(s);
      break;
    }
    case "dev": {
      const s = await status();
      // Process env wins over dotenv; existing hosted .env.local remains untouched.
      const child = spawn(
        process.execPath,
        [
          join(root, "node_modules/next/dist/bin/next"),
          "dev",
          "--hostname",
          "127.0.0.1",
        ],
        {
          cwd: root,
          stdio: "inherit",
          env: {
            ...localEnvironment(),
            NEXT_PUBLIC_SUPABASE_URL: s.api,
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: s.publishable,
          },
        },
      );
      child.on("error", () => {
        console.error("Unable to start the local frontend.");
        process.exitCode = 1;
      });
      child.on("exit", (code) => {
        process.exitCode = code ?? 1;
      });
      for (const signal of ["SIGINT", "SIGTERM"])
        process.on(signal, () => child.kill(signal));
      break;
    }
    default:
      throw new Error(
        "Choose doctor, start, stop, status, env, migrate, reset, seed, smoke or dev.",
      );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
