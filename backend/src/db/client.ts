import pg from 'pg';
import { config } from '../config.js';

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
});

pool.query('SELECT 1')
  .then(() => console.log('PostgreSQL connected'))
  .catch((err) => console.error('PostgreSQL connection failed:', err.message));

export async function query(text: string, params?: unknown[]) {
  return pool.query(text, params);
}

export { pool };
export default pool;
