import pg from 'pg'; import bcrypt from 'bcryptjs';
const {Pool}=pg; const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const names=['Hunter','lj','val','arthur','ben','david','zane','jonah'];
const passwords=process.env.BASTION_PASSWORDS?JSON.parse(process.env.BASTION_PASSWORDS):{};
for(const username of names){if(!passwords[username]) throw new Error('Missing password for '+username);const hash=await bcrypt.hash(passwords[username],12);await pool.query(`INSERT INTO players(username,password_hash) VALUES($1,$2) ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash`,[username,hash]);}
await pool.end(); console.log('Accounts initialized.');
