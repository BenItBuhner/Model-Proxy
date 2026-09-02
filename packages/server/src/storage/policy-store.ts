import { getOperationalDb } from "./operational-db.ts";

export type EntitlementResourceType = "model" | "audio_model" | "route" | "fusion_model";

export interface UserEntitlement {
  userId: string;
  resourceType: EntitlementResourceType;
  resourceId: string;
  allowed: boolean;
  createdAt: string;
  updatedAt: string;
}

interface EntitlementRow {
  user_id: string;
  resource_type: EntitlementResourceType;
  resource_id: string;
  allowed: number;
  created_at: string;
  updated_at: string;
}

export function listUserEntitlements(userId: string): UserEntitlement[] {
  const rows = getOperationalDb()
    .query("SELECT * FROM user_entitlements WHERE user_id = $user_id ORDER BY resource_type, resource_id")
    .all({ $user_id: userId }) as EntitlementRow[];
  return rows.map(entitlementFromRow);
}

export function setUserEntitlements(userId: string, entitlements: Array<{
  resourceType: EntitlementResourceType;
  resourceId: string;
  allowed?: boolean;
}>): UserEntitlement[] {
  const db = getOperationalDb();
  const now = new Date().toISOString();
  const tx = db.transaction((items: typeof entitlements) => {
    db.query("DELETE FROM user_entitlements WHERE user_id = $user_id").run({ $user_id: userId });
    for (const item of items) {
      if (item.resourceId.trim() === "") continue;
      db.query(
        `INSERT INTO user_entitlements (
          user_id, resource_type, resource_id, allowed, created_at, updated_at
        ) VALUES (
          $user_id, $resource_type, $resource_id, $allowed, $created_at, $updated_at
        )`,
      ).run({
        $user_id: userId,
        $resource_type: item.resourceType,
        $resource_id: item.resourceId.trim(),
        $allowed: item.allowed === false ? 0 : 1,
        $created_at: now,
        $updated_at: now,
      });
    }
  });
  tx(entitlements);
  return listUserEntitlements(userId);
}

export function hasAllowedEntitlement(
  userId: string,
  resourceType: EntitlementResourceType,
  resourceId: string,
): boolean {
  const db = getOperationalDb();
  const row = db
    .query(
      `SELECT allowed FROM user_entitlements
       WHERE user_id = $user_id
         AND resource_type = $resource_type
         AND resource_id = $resource_id`,
    )
    .get({ $user_id: userId, $resource_type: resourceType, $resource_id: resourceId }) as { allowed: number } | null;
  if (row?.allowed === 1) return true;
  if (row?.allowed === 0) return false;
  const configured = db
    .query(
      `SELECT 1 AS present FROM user_entitlements
       WHERE user_id = $user_id AND resource_type = $resource_type LIMIT 1`,
    )
    .get({ $user_id: userId, $resource_type: resourceType }) as { present: number } | null;
  return configured === null;
}

function entitlementFromRow(row: EntitlementRow): UserEntitlement {
  return {
    userId: row.user_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    allowed: row.allowed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
