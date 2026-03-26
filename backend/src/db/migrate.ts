import fs from 'fs';
import path from 'path';
import { pool, query } from './client.js';

async function migrate() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT UNIQUE NOT NULL,
        executed_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    const migrationsDir = path.join(__dirname, '../../migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('No migration files found.');
    }

    const { rows: executed } = await query('SELECT filename FROM schema_migrations');
    const executedSet = new Set(executed.map((r: { filename: string }) => r.filename));

    let count = 0;
    for (const file of files) {
      if (executedSet.has(file)) {
        console.log(`Already executed: ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      await query(sql);
      await query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      console.log(`Executed migration: ${file}`);
      count++;
    }

    console.log(`Migration complete. ${count} new migration(s) applied.`);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
