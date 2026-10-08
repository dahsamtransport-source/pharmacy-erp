// Repair Docker Desktop port publication without deleting local database volumes.
// Only the two named review containers are eligible. Old stopped containers remain
// available for recovery until the replacement passes the normal status checks.
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import {
  dockerReady,
  project,
  network,
  guardProject,
} from "./local-support.mjs";

await guardProject();
await dockerReady();
const context = JSON.parse(
  execFileSync("docker", ["context", "inspect"], { encoding: "utf8" }),
)[0];
const host = context.Endpoints.docker.Host;
if (!host.startsWith("npipe:"))
  throw new Error("This repair is for Windows Docker Desktop only.");
const socketPath = host.replace("npipe:////./pipe/", "\\\\.\\pipe\\");
function api(path, body) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": bytes.length,
        },
      },
      (res) => {
        let output = "";
        res.on("data", (d) => (output += d));
        res.on("end", () => {
          if (res.statusCode >= 300)
            return reject(
              new Error(`Docker create failed (${res.statusCode})`),
            );
          resolve(JSON.parse(output));
        });
      },
    );
    req.on("error", reject);
    req.end(bytes);
  });
}
for (const kind of ["db", "kong"]) {
  const name = `supabase_${kind}_${project}`;
  const c = JSON.parse(
    execFileSync("docker", ["inspect", name], { encoding: "utf8" }),
  )[0];
  if (
    c.Config.Labels?.["com.supabase.cli.project"] !== project ||
    c.HostConfig.NetworkMode !== network
  )
    throw new Error("Unexpected review container identity");
  const ports = Object.values(c.HostConfig.PortBindings || {}).flat();
  if (ports.every((p) => p.HostIp === "127.0.0.1")) continue;
  execFileSync("docker", ["stop", name]);
  const backup = `${name}-before-loopback-${Date.now()}`;
  execFileSync("docker", ["rename", name, backup]);
  for (const p of ports) p.HostIp = "127.0.0.1";
  const aliases = c.NetworkSettings.Networks[network]?.Aliases || [];
  await api(`/containers/create?name=${encodeURIComponent(name)}`, {
    ...c.Config,
    HostConfig: c.HostConfig,
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: aliases } } },
  });
  if (kind === "kong") {
    const source = spawn("docker", ["cp", `${backup}:/home/kong/.`, "-"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const destination = spawn("docker", ["cp", "-", `${name}:/home/kong`], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const sourceExit = once(source, "exit"),
      destinationExit = once(destination, "exit");
    await pipeline(source.stdout, destination.stdin);
    if ((await sourceExit)[0] !== 0 || (await destinationExit)[0] !== 0)
      throw new Error(
        "Gateway configuration copy failed; stopped backup retained",
      );
  }
  execFileSync("docker", ["start", name]);
  console.log(`${kind}: rebound to loopback; stopped backup retained`);
}
