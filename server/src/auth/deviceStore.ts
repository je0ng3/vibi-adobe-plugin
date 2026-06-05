import { randomInt, randomUUID } from "node:crypto";
import { query } from "../db/pool.js";

export interface DeviceUser {
  sub: string;
  email: string;
  name: string;
}

export type DeviceStatus = "pending" | "authorized" | "expired";

interface DeviceRecord {
  deviceCode: string;
  userCode: string;
  status: DeviceStatus;
  user?: DeviceUser;
  createdAt: number;
}

interface DeviceRow {
  device_code: string;
  user_code: string;
  status: "pending" | "authorized";
  user_sub: string | null;
  user_email: string | null;
  user_name: string | null;
  created_at: Date;
}

const TTL_MS = 10 * 60 * 1000;
// Avoid visually ambiguous characters (0/O, 1/I/L, 5/S, 8/B).
const USER_CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXYZ2346789";
const USER_CODE_LENGTH = 8;

function isRowExpired(row: DeviceRow): boolean {
  return Date.now() - row.created_at.getTime() > TTL_MS;
}

function rowToRecord(row: DeviceRow): DeviceRecord {
  const status: DeviceStatus = isRowExpired(row) ? "expired" : row.status;
  const record: DeviceRecord = {
    deviceCode: row.device_code,
    userCode: row.user_code,
    status,
    createdAt: row.created_at.getTime(),
  };
  if (row.user_sub) {
    record.user = { sub: row.user_sub, email: row.user_email ?? "", name: row.user_name ?? "" };
  }
  return record;
}

export async function createDeviceCode(): Promise<DeviceRecord> {
  const deviceCode = randomUUID();
  const userCode = generateUserCode();
  const res = await query<DeviceRow>(
    `INSERT INTO device_codes (device_code, user_code, status) VALUES ($1, $2, 'pending') RETURNING *`,
    [deviceCode, userCode],
  );
  return rowToRecord(res.rows[0]);
}

export async function pollDeviceCode(deviceCode: string): Promise<DeviceRecord | null> {
  if (!deviceCode) return null;
  const res = await query<DeviceRow>(`SELECT * FROM device_codes WHERE device_code = $1`, [deviceCode]);
  return res.rows[0] ? rowToRecord(res.rows[0]) : null;
}

export async function authorizeUserCode(userCode: string, user: DeviceUser): Promise<DeviceRecord | null> {
  const normalized = normalizeUserCode(userCode);
  const found = await query<DeviceRow>(`SELECT * FROM device_codes WHERE user_code = $1`, [normalized]);
  const row = found.rows[0];
  if (!row) return null;
  if (isRowExpired(row)) return rowToRecord(row); // status resolves to "expired"

  const updated = await query<DeviceRow>(
    `UPDATE device_codes
       SET status = 'authorized', user_sub = $2, user_email = $3, user_name = $4
     WHERE user_code = $1
     RETURNING *`,
    [normalized, user.sub, user.email, user.name],
  );
  return rowToRecord(updated.rows[0]);
}

/**
 * Consume a device code once its access token has been issued. Makes the code single-use so a
 * leaked deviceCode can't be re-polled to mint additional tokens within the TTL window.
 */
export async function deleteDeviceCode(deviceCode: string): Promise<void> {
  if (!deviceCode) return;
  await query(`DELETE FROM device_codes WHERE device_code = $1`, [deviceCode]);
}

export function normalizeUserCode(userCode: string): string {
  return userCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Remove device codes past their TTL; returns the count deleted. Called by the cleanup sweep. */
export async function deleteExpiredDeviceCodes(): Promise<number> {
  const res = await query(
    `DELETE FROM device_codes WHERE created_at < now() - ($1 || ' milliseconds')::interval`,
    [String(TTL_MS)],
  );
  return res.rowCount ?? 0;
}

function generateUserCode(): string {
  // CSPRNG, not Math.random: the user code is a brute-force surface (authorizeUserCode),
  // so it must not be predictable.
  let code = "";
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return code;
}

export { TTL_MS as DEVICE_CODE_TTL_MS };
