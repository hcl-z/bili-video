import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const worker = fileURLToPath(new URL("worker.mjs", import.meta.url));
const command = process.argv[2] ?? "probe";
const args = process.argv.slice(3);
const allowUnavailable = takeFlag(args, "--allow-unavailable");
const requestedRuntime = takeOption(args, "--runtime");

if (!new Set(["probe", "generate", "transcribe"]).has(command)) {
  fail("usage: node runner.mjs probe [--runtime bun|node] [--allow-unavailable]\n       node runner.mjs generate --runtime bun [--model <repo>] [--prompt <text>]\n       node runner.mjs transcribe --runtime bun --audio <file> --assets <dir>");
}

const runtimes = requestedRuntime ? [requestedRuntime] : command === "probe" ? ["bun", "node"] : ["bun"];
const results = [];
for (const runtime of runtimes) {
  results.push(await runIsolated(runtime, command, args));
}

const report = { package: "@nielspeter/mlx-ts@0.4.1", command, results };
console.log(JSON.stringify(report, null, 2));

const ok = results.every((result) => result.ok);
if (!ok && !allowUnavailable) process.exitCode = 1;

async function runIsolated(runtime, childCommand, childArgs) {
  if (!new Set(["bun", "node"]).has(runtime)) {
    return { runtime, ok: false, kind: "invalid-runtime", message: "runtime must be bun or node" };
  }

  const executable = runtime === "node" ? process.execPath : await findExecutable("bun");
  if (!executable) {
    return { runtime, ok: false, kind: "runtime-missing", message: `${runtime} is not installed` };
  }

  return await new Promise((resolve) => {
    const child = spawn(executable, [worker, childCommand, ...childArgs], {
      cwd: here,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ runtime, ok: false, kind: "spawn-error", message: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const payload = lastJsonLine(stdout);
      if (code === 0 && payload?.ok === true) {
        resolve({ runtime, ...payload });
        return;
      }
      resolve({
        runtime,
        ok: false,
        kind: signal ? "native-crash" : payload?.kind ?? "worker-error",
        code,
        signal,
        message:
          payload?.message ??
          (signal === "SIGSEGV"
            ? "mlx-ts crashed inside the Node/Koffi native callback boundary"
            : summarize(stderr || stdout)),
      });
    });
  });
}

async function findExecutable(name) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const path = `${dir}/${name}`;
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {}
  }
  return null;
}

function takeFlag(values, flag) {
  const index = values.indexOf(flag);
  if (index === -1) return false;
  values.splice(index, 1);
  return true;
}

function takeOption(values, option) {
  const index = values.indexOf(option);
  if (index === -1) return undefined;
  const value = values[index + 1];
  values.splice(index, 2);
  return value;
}

function lastJsonLine(output) {
  for (const line of output.trim().split("\n").reverse()) {
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

function summarize(output) {
  const lines = output.trim().split("\n").filter(Boolean);
  return lines.slice(-8).join("\n") || "worker exited without diagnostics";
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
