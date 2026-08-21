import bcrypt from 'bcryptjs';

export const ACCOUNT_SEEDS = {
  "Hunter": "ryu",
  "Val": "pasta",
  "Lj": "alan",
  "Zane": "hacker",
  "Jonah": "Durlik",
  "David": "vecna",
  "Ben": "Jen"
};

export async function ensureSeedAccounts(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  for (const [username, password] of Object.entries(ACCOUNT_SEEDS)) {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO accounts (username, password_hash)
       VALUES ($1,$2)
       ON CONFLICT (username) DO NOTHING`,
      [username, hash]
    );
  }
}

export async function verifyLogin(pool, username, password) {
  const r = await pool.query('SELECT id, username, password_hash FROM accounts WHERE LOWER(username)=LOWER($1)', [username]);
  if (!r.rows.length) return null;
  const ok = await bcrypt.compare(password, r.rows[0].password_hash);
  return ok ? {id:r.rows[0].id, username:r.rows[0].username} : null;
}
