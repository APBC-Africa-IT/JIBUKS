/**
 * Augments Express's Request type with the fields our middleware attaches.
 * This is what lets `req.tenantId` be a properly typed string everywhere,
 * rather than an untyped property bolted on at runtime.
 */

declare namespace Express {
  export interface Request {
    tenantId?: string;
  }
}