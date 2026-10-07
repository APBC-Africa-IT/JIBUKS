/**
 * Starts an app on 127.0.0.1 for the rest of a test file.
 *
 * Why not request(app): supertest then listens on an ephemeral port on ALL
 * addresses but connects to 127.0.0.1. On macOS another program may already
 * hold that same port on 127.0.0.1 alone (desktop apps such as Bruno or
 * VS Code helpers do), and the request lands there instead -- the cause of
 * the suite's intermittent 404s, hangs and "socket hang up" errors. Binding
 * to 127.0.0.1 makes the OS pick a port that is free on the address we
 * actually connect to. One server per file also avoids churning ports.
 */

import { once } from "node:events";
import type { Server } from "node:http";
import type { Express } from "express";
import { afterAll } from "vitest";

export async function listen(app: Express): Promise<Server> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return server;
}
