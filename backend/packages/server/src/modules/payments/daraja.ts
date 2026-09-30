/**
 * Safaricom Daraja API client -- the ONLY file that talks to M-Pesa.
 *
 * Covers what STK push needs: OAuth access token, STK push (Lipa na
 * M-Pesa Online) and STK push query. Configured from the environment:
 *
 *   MPESA_ENV               "sandbox" | "production"
 *   MPESA_CONSUMER_KEY      Daraja app key
 *   MPESA_CONSUMER_SECRET   Daraja app secret
 *   MPESA_SHORTCODE         Paybill/till the money lands in (sandbox: 174379)
 *   MPESA_PASSKEY           Lipa na M-Pesa Online passkey for that shortcode
 *   MPESA_CALLBACK_BASE_URL Public HTTPS origin Safaricom calls back
 *   MPESA_TRANSACTION_TYPE  Optional; "CustomerPayBillOnline" (default) or
 *                           "CustomerBuyGoodsOnline" for a till
 *
 * Config is read lazily, NOT at import: the server must still start (and
 * every non-payment test run) without M-Pesa configured -- payment
 * endpoints then answer 503 PAYMENTS_NOT_CONFIGURED.
 *
 * Phase 1 uses one platform-wide shortcode. In production each tenant
 * collects into its OWN paybill/till, so config will move per tenant;
 * the DarajaClient interface is the seam for that.
 */

import { DomainError } from "@jibuks/domain";

export interface StkPushRequest {
  readonly phone: string; // 2547XXXXXXXX
  readonly amountShillings: number;
  readonly accountReference: string;
  readonly transactionDesc: string;
  readonly callbackUrl: string;
}

export interface StkPushResponse {
  readonly merchantRequestId: string;
  readonly checkoutRequestId: string;
}

/** Result of asking Daraja what happened to a push. `pending` means Daraja
 * hasn't finished processing it yet. */
export type StkQueryResult =
  | { readonly state: "pending" }
  | { readonly state: "complete"; readonly resultCode: string; readonly resultDesc: string };

export interface DarajaClient {
  readonly callbackBaseUrl: string;
  stkPush(request: StkPushRequest): Promise<StkPushResponse>;
  stkQuery(checkoutRequestId: string): Promise<StkQueryResult>;
}

interface DarajaConfig {
  readonly baseUrl: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly shortcode: string;
  readonly passkey: string;
  readonly callbackBaseUrl: string;
  readonly transactionType: "CustomerPayBillOnline" | "CustomerBuyGoodsOnline";
}

const BASE_URLS = {
  sandbox: "https://sandbox.safaricom.co.ke",
  production: "https://api.safaricom.co.ke",
} as const;

/**
 * Daraja's STK query answers "still processing" as HTTP 500 with errorCode
 * 500.001.1001 -- but reuses that SAME code for other failures, notably
 * "Wrong credentials" (bad passkey). Only the message tells them apart, and
 * treating a config error as "still processing" would leave every payment
 * PENDING forever.
 */
function isStillProcessing(body: Record<string, unknown>): boolean {
  return body["errorCode"] === "500.001.1001" && /being processed/i.test(String(body["errorMessage"] ?? ""));
}

function readConfig(): DarajaConfig | null {
  const env = process.env;
  const mode = env["MPESA_ENV"];
  const consumerKey = env["MPESA_CONSUMER_KEY"];
  const consumerSecret = env["MPESA_CONSUMER_SECRET"];
  const shortcode = env["MPESA_SHORTCODE"];
  const passkey = env["MPESA_PASSKEY"];
  const callbackBaseUrl = env["MPESA_CALLBACK_BASE_URL"];
  if (
    (mode !== "sandbox" && mode !== "production") ||
    !consumerKey ||
    !consumerSecret ||
    !shortcode ||
    !passkey ||
    !callbackBaseUrl
  ) {
    return null;
  }
  return {
    baseUrl: BASE_URLS[mode],
    consumerKey,
    consumerSecret,
    shortcode,
    passkey,
    callbackBaseUrl: callbackBaseUrl.replace(/\/+$/, ""),
    transactionType:
      env["MPESA_TRANSACTION_TYPE"] === "CustomerBuyGoodsOnline" ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline",
  };
}

/** yyyyMMddHHmmss in East Africa Time, as Daraja's password scheme requires. */
function darajaTimestamp(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}${get("month")}${get("day")}${get("hour")}${get("minute")}${get("second")}`;
}

function providerError(message: string): DomainError {
  return new DomainError("PAYMENT_PROVIDER_ERROR", message);
}

function createHttpDarajaClient(config: DarajaConfig): DarajaClient {
  let cachedToken: { value: string; expiresAt: number } | undefined;

  async function accessToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
      return cachedToken.value;
    }
    const basic = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString("base64");
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: { authorization: `Basic ${basic}` },
      });
    } catch (err) {
      throw providerError(`Could not reach M-Pesa: ${(err as Error).message}`);
    }
    if (!response.ok) {
      throw providerError(`M-Pesa rejected our credentials (HTTP ${response.status})`);
    }
    const body = (await response.json()) as { access_token: string; expires_in: string | number };
    // Refresh a minute early so a token never expires mid-request.
    cachedToken = { value: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) - 60) * 1000 };
    return cachedToken.value;
  }

  async function post(path: string, payload: object): Promise<{ status: number; body: Record<string, unknown> }> {
    const token = await accessToken();
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw providerError(`Could not reach M-Pesa: ${(err as Error).message}`);
    }
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Non-JSON error page -- leave body empty, status carries the signal.
    }
    return { status: response.status, body };
  }

  function password(timestamp: string): string {
    return Buffer.from(`${config.shortcode}${config.passkey}${timestamp}`).toString("base64");
  }

  return {
    callbackBaseUrl: config.callbackBaseUrl,

    async stkPush(request) {
      const timestamp = darajaTimestamp();
      const { status, body } = await post("/mpesa/stkpush/v1/processrequest", {
        BusinessShortCode: config.shortcode,
        Password: password(timestamp),
        Timestamp: timestamp,
        TransactionType: config.transactionType,
        Amount: request.amountShillings,
        PartyA: request.phone,
        PartyB: config.shortcode,
        PhoneNumber: request.phone,
        CallBackURL: request.callbackUrl,
        AccountReference: request.accountReference,
        TransactionDesc: request.transactionDesc,
      });
      if (status !== 200 || String(body["ResponseCode"]) !== "0") {
        const reason = (body["errorMessage"] ?? body["ResponseDescription"] ?? `HTTP ${status}`) as string;
        throw providerError(`M-Pesa did not accept the payment request: ${reason}`);
      }
      return {
        merchantRequestId: String(body["MerchantRequestID"]),
        checkoutRequestId: String(body["CheckoutRequestID"]),
      };
    },

    async stkQuery(checkoutRequestId) {
      const timestamp = darajaTimestamp();
      const { status, body } = await post("/mpesa/stkpushquery/v1/query", {
        BusinessShortCode: config.shortcode,
        Password: password(timestamp),
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId,
      });
      if (isStillProcessing(body)) {
        return { state: "pending" };
      }
      if (status !== 200 || body["ResultCode"] === undefined) {
        const reason = (body["errorMessage"] ?? `HTTP ${status}`) as string;
        throw providerError(`M-Pesa status query failed: ${reason}`);
      }
      return {
        state: "complete",
        resultCode: String(body["ResultCode"]),
        resultDesc: String(body["ResultDesc"] ?? ""),
      };
    },
  };
}

let client: DarajaClient | null | undefined;

/** The configured client, or 503 PAYMENTS_NOT_CONFIGURED. */
export function getDarajaClient(): DarajaClient {
  if (client === undefined) {
    const config = readConfig();
    client = config ? createHttpDarajaClient(config) : null;
  }
  if (!client) {
    throw new DomainError("PAYMENTS_NOT_CONFIGURED", "M-Pesa payments are not configured on this server");
  }
  return client;
}

/** Tests only: substitute a fake, null for "not configured", or undefined
 * to re-read the environment on next use. */
export function setDarajaClientForTesting(fake: DarajaClient | null | undefined): void {
  client = fake;
}
