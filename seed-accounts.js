import pg from 'pg';
import bcrypt from 'bcryptjs';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined
});

const names = ['Hunter', 'lj', 'val', 'arthur', 'ben', 'david', 'zane', 'jonah'];

if (!process.env.BASTION_PASSWORDS) {
  throw new Error('Set BASTION_PASSWORDS in Render before running npm run seed. Keep it out of GitHub.');
}

let passwords;
try {
  passwords = JSON.parse(process.env.BASTION_PASSWORDS);
} catch {
  throw new Error('BASTION_PASSWORDS must be valid JSON.');
}

for (const username of names) {
  if (!passwords[username]) throw new Error(`Missing password for ${username}`);
  const hash = await bcrypt.hash(passwords[username], 12);
  await pool.query(
    `INSERT INTO players(username,password_hash)
     VALUES($1,$2)
     ON CONFLICT(username)
     DO UPDATE SET password_hash=EXCLUDED.password_hash`,
    [username, hash]
  );
}

await pool.end();
console.log('All 8 Bastion accounts initialized with secure password hashes.');
