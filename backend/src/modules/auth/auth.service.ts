import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from '../../db/client.js';
import { config } from '../../config.js';
import { UnauthorizedError, NotFoundError } from '../../shared/errors.js';
import type { JwtUserPayload } from '../../shared/types.js';

export async function login(email: string, password: string) {
  const { rows } = await pool.query(
    `SELECT id, email, password_hash, full_name, role, supervisor_user_id
     FROM users WHERE email = $1`,
    [email]
  );

  if (rows.length === 0) {
    throw new UnauthorizedError('Invalid credentials');
  }

  const user = rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new UnauthorizedError('Invalid credentials');
  }

  let zoneIds: string[] = [];
  if (user.role === 'operator') {
    const { rows: zones } = await pool.query(
      `SELECT zone_id FROM user_zone_assignments WHERE user_id = $1`,
      [user.id]
    );
    zoneIds = zones.map((z: { zone_id: string }) => z.zone_id);
  }

  const payload: JwtUserPayload = {
    userId: user.id,
    role: user.role,
    zoneIds,
  };

  const token = jwt.sign(payload, config.jwtSecret, { expiresIn: '24h' });

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      zone_ids: zoneIds,
    },
  };
}

export async function getUserById(userId: string) {
  const { rows } = await pool.query(
    `SELECT id, email, full_name, role FROM users WHERE id = $1`,
    [userId]
  );

  if (rows.length === 0) {
    throw new NotFoundError('User not found');
  }

  const user = rows[0];

  let zoneIds: string[] = [];
  if (user.role === 'operator') {
    const { rows: zones } = await pool.query(
      `SELECT zone_id FROM user_zone_assignments WHERE user_id = $1`,
      [user.id]
    );
    zoneIds = zones.map((z: { zone_id: string }) => z.zone_id);
  }

  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    zone_ids: zoneIds,
  };
}
