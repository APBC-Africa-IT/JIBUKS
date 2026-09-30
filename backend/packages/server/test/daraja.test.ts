/**
 * The real HTTP Daraja client, against scripted Safaricom responses
 * (fetch is stubbed -- nothing leaves the machine). payments.test.ts
 * covers the flow with a fake client; this covers how Safaricom's actual
 * response shapes are interpreted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDarajaClient, setDarajaClientForTesting } from "../src/modules/payments/daraja.js";

const ENV = {
  MPESA_ENV: "sandbox",
  MPESA_CONSUMER_KEY: "key",
  MPESA_CONSUMER_SECRET: "secret",
  MPESA_SHORTCODE: "174379",
  MPESA_PASSKEY: "passkey",
  MPESA_CALLBACK_BASE_URL: "https://staging.example.test/",
};

/** Answers the OAuth call, then `queryStatus`/`queryBody` for the STK query. */
function stubSafaricom(queryStatus: number, queryBody: object) {
  const calls: { url: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
    calls.push({ url, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    if (url.includes("/oauth/")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: "3599" }), { status: 200 });
    }
    return new Response(JSON.stringify(queryBody), { status: queryStatus });
  });
  return calls;
}

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) {
    vi.stubEnv(k, v);
  }
  setDarajaClientForTesting(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setDarajaClientForTesting(undefined);
});

describe("Daraja STK query", () => {
  it("treats 'being processed' as still pending", async () => {
    stubSafaricom(500, { errorCode: "500.001.1001", errorMessage: "The transaction is being processed" });
    await expect(getDarajaClient().stkQuery("ws_CO_1")).resolves.toEqual({ state: "pending" });
  });

  it("does NOT treat 'Wrong credentials' (same errorCode) as pending -- it's a config error", async () => {
    stubSafaricom(500, { errorCode: "500.001.1001", errorMessage: "Wrong credentials" });
    await expect(getDarajaClient().stkQuery("ws_CO_1")).rejects.toMatchObject({
      code: "PAYMENT_PROVIDER_ERROR",
      message: expect.stringContaining("Wrong credentials"),
    });
  });

  it("returns the result code of a completed request, as a string", async () => {
    stubSafaricom(200, { ResponseCode: "0", ResultCode: 1032, ResultDesc: "Request cancelled by user" });
    await expect(getDarajaClient().stkQuery("ws_CO_1")).resolves.toEqual({
      state: "complete",
      resultCode: "1032",
      resultDesc: "Request cancelled by user",
    });
  });

  it("signs the query with base64(shortcode + passkey + EAT timestamp)", async () => {
    const calls = stubSafaricom(200, { ResultCode: "0", ResultDesc: "ok" });
    await getDarajaClient().stkQuery("ws_CO_1");

    const body = calls.find((c) => c.url.endsWith("/stkpushquery/v1/query"))!.body as Record<string, string>;
    expect(body["Timestamp"]).toMatch(/^\d{14}$/);
    expect(Buffer.from(body["Password"]!, "base64").toString()).toBe(`174379passkey${body["Timestamp"]}`);
    expect(getDarajaClient().callbackBaseUrl).toBe("https://staging.example.test");
  });
});
