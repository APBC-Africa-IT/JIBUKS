/**
 * Server entrypoint. Only responsibility: create the app and listen.
 */

import { createApp } from "./app.js";

const PORT = process.env["PORT"] ?? 3000;

const app = createApp();

app.listen(PORT, () => {
  console.log(`JiBUks server listening on port ${PORT}`);
});