/**
 * Runs the workspace API server as a child of the shell.
 *
 * This is where UA_SESSION_BRIDGE_URL is wired: the shell starts its loopback
 * publisher endpoint first, then hands the child that address. An API server
 * started any other way has no bridge and correctly refuses to publish.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { waitForHttpOk } from "./net";
import { createLogger } from "./logger";

const log = createLogger("api-server");

export type ApiServerHandle = {
  baseUrl: string;
  stop(): Promise<void>;
};

export async function startApiServer(options: {
  entry: string;
  port: number;
  bridgeUrl: string;
  /** Capability token for the bridge. Handed to this child and nobody else. */
  bridgeToken: string;
  /**
   * Token every caller of this API server must present. It holds the bridge
   * capability, so only the shell's own UI proxy may talk to it.
   */
  accessToken: string;
  dataDir: string;
  extraEnv?: Record<string, string | undefined>;
  startupTimeoutMs?: number;
}): Promise<ApiServerHandle> {
  const baseUrl = `http://127.0.0.1:${options.port}`;

  const child: ChildProcess = spawn(process.execPath, [options.entry], {
    env: {
      ...process.env,
      ...options.extraEnv,
      // In a packaged build `process.execPath` is Electron itself; this makes
      // it behave as a plain Node runtime for the child.
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: process.env.NODE_ENV ?? "production",
      PORT: String(options.port),
      // Loopback only: a process holding the publishing capability has no
      // business being reachable from the LAN.
      HOST: "127.0.0.1",
      UA_SESSION_BRIDGE_URL: options.bridgeUrl,
      UA_SESSION_BRIDGE_TOKEN: options.bridgeToken,
      UA_API_ACCESS_TOKEN: options.accessToken,
      NEDB_DATA_DIR: options.dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const tail: string[] = [];
  const remember = (chunk: Buffer) => {
    const text = chunk.toString("utf8").trimEnd();
    if (!text) return;
    tail.push(text);
    if (tail.length > 40) tail.shift();
    process.stdout.write(`${text}\n`);
  };

  child.stdout?.on("data", remember);
  child.stderr?.on("data", remember);

  let exited = false;
  child.on("exit", (code, signal) => {
    exited = true;
    log.warn("API server exited", { code, signal });
  });

  try {
    await waitForHttpOk(`${baseUrl}/api/healthz`, options.startupTimeoutMs ?? 30_000, 200, {
      "X-UA-Api-Token": options.accessToken,
    });
  } catch (error) {
    child.kill("SIGTERM");
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The workspace API server did not come up.\n${reason}\n${tail.join("\n")}`,
    );
  }

  log.info("API server ready", { baseUrl, bridgeUrl: options.bridgeUrl });

  return {
    baseUrl,
    stop: () =>
      new Promise<void>((resolve) => {
        if (exited || child.killed) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
}
