/**
 * Item catalogue (products and services) -- what the Item dropdowns on
 * sales and purchase lines pick from.
 *
 *   SERVICE        -- work sold, e.g. a haircut. No stock.
 *   NON_INVENTORY  -- goods bought or sold without counting stock.
 *   INVENTORY      -- stocked goods; buying them debits an Inventory
 *                     (ASSET) account. Only these may set trackStock.
 *
 * trackStock is stored now; quantity on hand and cost of goods sold are a
 * later step, so for the moment it changes no posting.
 */

export const ITEM_TYPES = ["SERVICE", "NON_INVENTORY", "INVENTORY"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
