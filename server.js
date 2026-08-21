import { ensureSeedAccounts, verifyLogin } from './accounts.js';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const { Pool } = pg;
const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});
await ensureSeedAccounts(pool);

const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_ON_RENDER';
if (JWT_SECRET === 'CHANGE_ME_ON_RENDER') console.warn('WARNING: Set JWT_SECRET in Render environment variables.');

const ACCOUNTS = ['Hunter', 'lj', 'val', 'arthur', 'ben', 'david', 'zane', 'jonah'];
const clean = s => String(s ?? '').trim();

async function db() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      gems INTEGER NOT NULL DEFAULT 2500 CHECK (gems >= 0),
      gold INTEGER NOT NULL DEFAULT 150 CHECK (gold >= 0),
      shards INTEGER NOT NULL DEFAULT 0 CHECK (shards >= 0),
      collection JSONB NOT NULL DEFAULT '{}'::jsonb,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      from_user TEXT NOT NULL,
      to_user TEXT NOT NULL,
      offer JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      responded_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS vs_challenges (
      id SERIAL PRIMARY KEY,
      from_user TEXT NOT NULL,
      to_user TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      responded_at TIMESTAMPTZ
    );
  `);
}

function sign(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
}
function auth(req, res, next) {
  try {
    const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    req.user = jwt.verify(t, JWT_SECRET);
    if (!ACCOUNTS.includes(req.user.username)) throw new Error('Unknown user');
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}
function publicPlayer(p) {
  return {
    username: p.username,
    gems: p.gems,
    gold: p.gold,
    shards: p.shards,
    collection: p.collection || {},
    wins: p.wins,
    losses: p.losses
  };
}
function validOffer(offer) {
  if (!offer || typeof offer !== 'object') return null;
  const gems = Number.isInteger(offer.gems) ? offer.gems : 0;
  const shards = Number.isInteger(offer.shards) ? offer.shards : 0;
  const units = Array.isArray(offer.units) ? offer.units : [];
  if (gems < 0 || shards < 0 || gems > 1000000 || shards > 1000000 || units.length > 50) return null;
  const cleanUnits = [];
  for (const raw of units) {
    const name = clean(raw?.name);
    const count = Number.isInteger(raw?.count) ? raw.count : 0;
    if (!name || count < 1 || count > 100) return null;
    cleanUnits.push({ name, count });
  }
  return { gems, shards, units: cleanUnits };
}
function hasUnits(collection, units) {
  return units.every(u => Number(collection?.[u.name] || 0) >= u.count);
}
function applyUnits(collection, units, sign) {
  const next = { ...(collection || {}) };
  for (const u of units) {
    const n = Math.max(0, Number(next[u.name] || 0) + sign * u.count);
    if (n === 0) delete next[u.name]; else next[u.name] = n;
  }
  return next;
}

app.get('/api/health', async (_, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, service: 'bastion-td', accounts: ACCOUNTS.length }); }
  catch { res.status(503).json({ ok: false, error: 'Database unavailable' }); }
});
app.get('/api/accounts', (_, res) => res.json({ accounts: ACCOUNTS }));

app.post('/api/login', async (req, res) => {
  try {
    const u = clean(req.body.username);
    const p = String(req.body.password || '');
    if (!ACCOUNTS.includes(u) || !p) return res.status(401).json({ error: 'Invalid login' });
    const q = await pool.query('SELECT * FROM players WHERE username=$1', [u]);
    if (!q.rowCount) return res.status(401).json({ error: 'Account not initialized yet' });
    if (!(await bcrypt.compare(p, q.rows[0].password_hash))) return res.status(401).json({ error: 'Invalid login' });
    res.json({ token: sign(u), player: publicPlayer(q.rows[0]) });
  } catch (e) { res.status(500).json({ error: 'Login failed' }); }
});

app.get('/api/me', auth, async (req, res) => {
  const q = await pool.query('SELECT * FROM players WHERE username=$1', [req.user.username]);
  if (!q.rowCount) return res.status(404).json({ error: 'Account not found' });
  res.json(publicPlayer(q.rows[0]));
});
app.get('/api/players', auth, (_, res) => res.json({ players: ACCOUNTS }));

app.post('/api/trades', auth, async (req, res) => {
  try {
    const to = clean(req.body.to);
    const offer = validOffer(req.body.offer);
    if (!ACCOUNTS.includes(to) || to === req.user.username) return res.status(400).json({ error: 'Invalid recipient' });
    if (!offer) return res.status(400).json({ error: 'Invalid trade offer' });
    const sender = await pool.query('SELECT * FROM players WHERE username=$1', [req.user.username]);
    if (!sender.rowCount || sender.rows[0].gems < offer.gems || sender.rows[0].shards < offer.shards || !hasUnits(sender.rows[0].collection, offer.units)) {
      return res.status(400).json({ error: 'You do not own everything in that offer' });
    }
    const q = await pool.query('INSERT INTO trades(from_user,to_user,offer) VALUES($1,$2,$3) RETURNING *', [req.user.username, to, JSON.stringify(offer)]);
    res.json(q.rows[0]);
  } catch { res.status(500).json({ error: 'Could not create trade' }); }
});

app.get('/api/trades', auth, async (req, res) => {
  const q = await pool.query('SELECT * FROM trades WHERE from_user=$1 OR to_user=$1 ORDER BY id DESC LIMIT 100', [req.user.username]);
  res.json(q.rows);
});

app.post('/api/trades/:id/respond', auth, async (req, res) => {
  const status = ['accepted', 'declined'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'Bad status' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tq = await client.query('SELECT * FROM trades WHERE id=$1 AND to_user=$2 FOR UPDATE', [req.params.id, req.user.username]);
    if (!tq.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Trade not found' }); }
    const trade = tq.rows[0];
    if (trade.status !== 'pending') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Trade already resolved' }); }
    if (status === 'declined') {
      const q = await client.query('UPDATE trades SET status=$1, responded_at=now() WHERE id=$2 RETURNING *', [status, trade.id]);
      await client.query('COMMIT'); return res.json(q.rows[0]);
    }
    const offer = validOffer(trade.offer);
    if (!offer) throw new Error('Invalid stored offer');
    const users = await client.query('SELECT * FROM players WHERE username = ANY($1) FOR UPDATE', [[trade.from_user, trade.to_user]]);
    const byName = Object.fromEntries(users.rows.map(p => [p.username, p]));
    const from = byName[trade.from_user], to = byName[trade.to_user];
    if (from.gems < offer.gems || from.shards < offer.shards || !hasUnits(from.collection, offer.units)) {
      await client.query('UPDATE trades SET status=$1, responded_at=now() WHERE id=$2', ['declined', trade.id]);
      await client.query('COMMIT'); return res.status(409).json({ error: 'Sender no longer owns the offered items; trade declined' });
    }
    const fromCollection = applyUnits(from.collection, offer.units, -1);
    const toCollection = applyUnits(to.collection, offer.units, 1);
    await client.query('UPDATE players SET gems=gems-$1, shards=shards-$2, collection=$3 WHERE username=$4', [offer.gems, offer.shards, JSON.stringify(fromCollection), from.username]);
    await client.query('UPDATE players SET gems=gems+$1, shards=shards+$2, collection=$3 WHERE username=$4', [offer.gems, offer.shards, JSON.stringify(toCollection), to.username]);
    const q = await client.query('UPDATE trades SET status=$1, responded_at=now() WHERE id=$2 RETURNING *', ['accepted', trade.id]);
    await client.query('COMMIT'); res.json(q.rows[0]);
  } catch { await client.query('ROLLBACK'); res.status(500).json({ error: 'Could not resolve trade' }); }
  finally { client.release(); }
});

app.post('/api/vs/challenge', auth, async (req, res) => {
  const opponent = clean(req.body.opponent);
  if (!ACCOUNTS.includes(opponent) || opponent === req.user.username) return res.status(400).json({ error: 'Invalid opponent' });
  const q = await pool.query('INSERT INTO vs_challenges(from_user,to_user) VALUES($1,$2) RETURNING *', [req.user.username, opponent]);
  const targetWs = sockets.get(opponent);
  if (targetWs) send(targetWs, { type: 'challenge_received', challenge: q.rows[0] });
  res.json(q.rows[0]);
});
app.get('/api/vs/challenges', auth, async (req, res) => {
  const q = await pool.query('SELECT * FROM vs_challenges WHERE from_user=$1 OR to_user=$1 ORDER BY id DESC LIMIT 50', [req.user.username]);
  res.json(q.rows);
});
app.post('/api/vs/challenges/:id/respond', auth, async (req, res) => {
  const status = ['accepted', 'declined'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'Bad status' });
  const q = await pool.query('UPDATE vs_challenges SET status=$1, responded_at=now() WHERE id=$2 AND to_user=$3 AND status=$4 RETURNING *', [status, req.params.id, req.user.username, 'pending']);
  if (!q.rowCount) return res.status(404).json({ error: 'Challenge not found or already resolved' });
  const row = q.rows[0];
  const otherWs = sockets.get(row.from_user);
  if (otherWs) send(otherWs, { type: 'challenge_response', challenge: row });
  res.json(row);
});

// Serve the game at the root so Render never shows "Cannot GET /".
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'Bastion_TD_Online.html')));
app.use(express.static(__dirname, { index: false }));
app.use('/api', (_, res) => res.status(404).json({ error: 'API route not found' }));

const port = process.env.PORT || 3000;
const matches = new Map();
const sockets = new Map();
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(match, msg) { for (const username of [match.p1, match.p2]) send(sockets.get(username), msg); }
function newMatch(p1, p2) {
  const id = 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const m = { id, p1, p2, hp: { [p1]: 100, [p2]: 100 }, gold: { [p1]: 500, [p2]: 500 }, wave: 1, ready: { [p1]: false, [p2]: false }, started: false, ended: false, units: [] };
  matches.set(id, m); return m;
}

const httpServer = await new Promise((resolve, reject) => { const s = app.listen(port, () => resolve(s)); s.on('error', reject); });
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
wss.on('connection', ws => {
  let username = null;
  let matchId = null;
  ws.on('message', async raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth') {
        try {
          const user = jwt.verify(String(msg.token || ''), JWT_SECRET).username;
          if (!ACCOUNTS.includes(user)) throw new Error();
          username = user; sockets.set(username, ws); send(ws, { type: 'authed', username });
          // Re-announce pending challenges after reconnect.
          pool.query('SELECT * FROM vs_challenges WHERE to_user=$1 AND status=$2 ORDER BY id DESC LIMIT 20', [username, 'pending'])
            .then(q => q.rows.forEach(c => send(ws, { type: 'challenge_received', challenge: c }))).catch(() => {});
        } catch { send(ws, { type: 'error', error: 'WebSocket authentication failed' }); ws.close(); }
        return;
      }
      if (!username) return send(ws, { type: 'error', error: 'Authenticate first' });

      if (msg.type === 'create_match') {
        const opponent = clean(msg.opponent);
        if (!ACCOUNTS.includes(opponent) || opponent === username) return send(ws, { type: 'error', error: 'Invalid opponent' });
        const existing = [...matches.values()].find(m => !m.ended && ((m.p1 === username && m.p2 === opponent) || (m.p1 === opponent && m.p2 === username)));
        const m = existing || newMatch(username, opponent); matchId = m.id;
        send(ws, { type: 'match_created', match: m });
        send(sockets.get(opponent), { type: 'incoming_match', match: m });
        return;
      }
      const m = matches.get(msg.matchId || matchId);
      if (!m) return send(ws, { type: 'error', error: 'Match not found' });
      if (username !== m.p1 && username !== m.p2) return send(ws, { type: 'error', error: 'Not in match' });
      matchId = m.id;

      if (msg.type === 'ready') {
        m.ready[username] = true;
        broadcast(m, { type: 'player_ready', player: username, ready: m.ready });
        if (m.ready[m.p1] && m.ready[m.p2] && !m.started) { m.started = true; broadcast(m, { type: 'match_started', match: m }); }
        return;
      }
      if (msg.type === 'send_enemy') {
        if (!m.started || m.ended) return send(ws, { type: 'error', error: 'Match is not live' });
        const target = username === m.p1 ? m.p2 : m.p1;
        const tier = Math.max(0, Math.min(3, Number(msg.tier) || 0));
        const cost = [20, 35, 50, 65][tier];
        if (m.gold[username] < cost) return send(ws, { type: 'error', error: 'Not enough gold' });
        m.gold[username] -= cost;
        const enemy = { id: Date.now() + Math.random(), from: username, target, type: ['Goblin', 'Runner', 'Brute', 'Wraith'][tier], tier, hp: 20 + tier * 30 };
        m.units.push(enemy); broadcast(m, { type: 'enemy_sent', enemy, gold: m.gold }); return;
      }
      if (msg.type === 'damage_enemy') {
        const enemy = m.units.find(x => String(x.id) === String(msg.enemyId) && x.target === username);
        if (!enemy || m.ended) return;
        enemy.hp -= Math.max(1, Number(msg.damage) || 1);
        if (enemy.hp <= 0) m.units = m.units.filter(x => x !== enemy);
        broadcast(m, { type: 'enemy_damaged', enemyId: msg.enemyId, remaining: Math.max(0, enemy.hp) }); return;
      }
      if (msg.type === 'damage_base') {
        if (!m.started || m.ended) return;
        const amount = Math.max(1, Math.min(25, Number(msg.amount) || 1));
        m.hp[username] -= amount;
        if (m.hp[username] <= 0) {
          m.hp[username] = 0; m.ended = true;
          const winner = username === m.p1 ? m.p2 : m.p1;
          await finishMatch(m, winner, username);
        } else broadcast(m, { type: 'base_damaged', player: username, hp: m.hp[username] });
        return;
      }
      if (msg.type === 'leave') {
        if (m.ended) return;
        m.ended = true; const winner = username === m.p1 ? m.p2 : m.p1;
        await finishMatch(m, winner, username); return;
      }
    } catch { send(ws, { type: 'error', error: 'Invalid message' }); }
  });
  ws.on('close', () => { if (username && sockets.get(username) === ws) sockets.delete(username); });
});

async function finishMatch(m, winner, loser) {
  m.ended = true;
  try {
    await pool.query('UPDATE players SET wins=wins+1, gold=gold+100 WHERE username=$1', [winner]);
    await pool.query('UPDATE players SET losses=losses+1 WHERE username=$1', [loser]);
  } catch {}
  broadcast(m, { type: 'match_ended', winner, loser, hp: m.hp, reward: 100 });
  setTimeout(() => matches.delete(m.id), 60_000);
}

await db();
console.log('Database ready.');
console.log('Bastion online on ' + port + ' with real-time VS WebSocket');


// ---- Bastion TD Trading API ----
async function ensureTradeTables(){
  await pool.query(`CREATE TABLE IF NOT EXISTS trades (
    id SERIAL PRIMARY KEY,
    from_user INTEGER NOT NULL REFERENCES accounts(id),
    to_user INTEGER NOT NULL REFERENCES accounts(id),
    offer JSONB NOT NULL,
    request JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
}
await ensureTradeTables();

app.get('/api/players', async (req,res)=>{
  try{
    const r=await pool.query('SELECT username FROM accounts ORDER BY username');
    res.json({players:r.rows.map(x=>x.username)});
  }catch(e){res.status(500).json({error:'Could not load players'});}
});

app.get('/api/trades', async (req,res)=>{
  try{
    const username=String(req.query.username||'');
    const r=await pool.query(
      `SELECT t.id,t.offer,t.request,t.status,t.created_at,
              a.username AS from_username,b.username AS to_username
       FROM trades t
       JOIN accounts a ON a.id=t.from_user
       JOIN accounts b ON b.id=t.to_user
       WHERE (a.username=$1 OR b.username=$1) AND t.status='pending'
       ORDER BY t.created_at DESC`, [username]);
    res.json({trades:r.rows});
  }catch(e){res.status(500).json({error:'Could not load trades'});}
});

app.post('/api/trades', async (req,res)=>{
  try{
    const {fromUsername,toUsername,offer,request}=req.body||{};
    if(!fromUsername||!toUsername||fromUsername.toLowerCase()===toUsername.toLowerCase())
      return res.status(400).json({error:'Choose another account'});
    if(!offer || !request) return res.status(400).json({error:'Trade contents missing'});
    const a=await pool.query('SELECT id FROM accounts WHERE LOWER(username)=LOWER($1)',[fromUsername]);
    const b=await pool.query('SELECT id FROM accounts WHERE LOWER(username)=LOWER($1)',[toUsername]);
    if(!a.rows.length||!b.rows.length) return res.status(404).json({error:'Account not found'});
    const r=await pool.query(
      `INSERT INTO trades(from_user,to_user,offer,request) VALUES($1,$2,$3,$4) RETURNING id`,
      [a.rows[0].id,b.rows[0].id,JSON.stringify(offer),JSON.stringify(request)]);
    res.json({ok:true,tradeId:r.rows[0].id});
  }catch(e){console.error(e);res.status(500).json({error:'Could not create trade'});}
});

app.post('/api/trades/:id/decline', async (req,res)=>{
  try{
    const id=Number(req.params.id), username=String(req.body?.username||'');
    const r=await pool.query(
      `UPDATE trades SET status='declined'
       WHERE id=$1 AND status='pending'
       AND to_user=(SELECT id FROM accounts WHERE LOWER(username)=LOWER($2))
       RETURNING id`,[id,username]);
    if(!r.rows.length)return res.status(403).json({error:'Trade unavailable'});
    res.json({ok:true});
  }catch(e){res.status(500).json({error:'Could not decline trade'});}
});

app.post('/api/trades/:id/accept', async (req,res)=>{
  // The existing player economy in this project is client-backed in places.
  // Do not silently mutate inventories here without a matching server-side
  // player-data schema. This endpoint only accepts the offer structure after
  // validation and marks it accepted; the UI can display the result.
  try{
    const id=Number(req.params.id), username=String(req.body?.username||'');
    const r=await pool.query(
      `UPDATE trades SET status='accepted'
       WHERE id=$1 AND status='pending'
       AND to_user=(SELECT id FROM accounts WHERE LOWER(username)=LOWER($2))
       RETURNING id,offer,request`,[id,username]);
    if(!r.rows.length)return res.status(403).json({error:'Trade unavailable'});
    res.json({ok:true,trade:r.rows[0]});
  }catch(e){res.status(500).json({error:'Could not accept trade'});}
});


// ---- Bastion TD Secure Economy ----
import crypto from 'node:crypto';

async function ensureEconomyTables(){
  await pool.query(`CREATE TABLE IF NOT EXISTS player_data (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    gems INTEGER NOT NULL DEFAULT 1000,
    gold INTEGER NOT NULL DEFAULT 0,
    shards INTEGER NOT NULL DEFAULT 0,
    inventory JSONB NOT NULL DEFAULT '{}'::jsonb
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS trades_secure (
    id SERIAL PRIMARY KEY,
    from_user INTEGER NOT NULL REFERENCES accounts(id),
    to_user INTEGER NOT NULL REFERENCES accounts(id),
    offer JSONB NOT NULL,
    request JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  const a=await pool.query('SELECT id FROM accounts');
  for(const row of a.rows){
    await pool.query(`INSERT INTO player_data(account_id) VALUES($1) ON CONFLICT DO NOTHING`,[row.id]);
  }
}
await ensureEconomyTables();

async function authUser(req){
  const token=req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : '';
  if(!token) return null;
  const r=await pool.query(
    `SELECT a.id,a.username FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token=$1`,
    [token]);
  return r.rows[0]||null;
}
function cleanInventory(inv){
  const out={};
  for(const [k,v] of Object.entries(inv||{})){
    const n=Math.max(0,Math.floor(Number(v)||0));
    if(n) out[k]=n;
  }
  return out;
}

app.post('/api/login', async (req,res)=>{
  try{
    const {username,password}=req.body||{};
    if(!username||!password)return res.status(400).json({error:'Username and password required'});
    const user=await verifyLogin(pool,username,password);
    if(!user)return res.status(401).json({error:'Invalid username or password'});
    const token=crypto.randomBytes(32).toString('hex');
    await pool.query('INSERT INTO sessions(token,account_id) VALUES($1,$2)',[token,user.id]);
    await pool.query(`INSERT INTO player_data(account_id) VALUES($1) ON CONFLICT DO NOTHING`,[user.id]);
    res.json({ok:true,user:{id:user.id,username:user.username},token});
  }catch(e){console.error(e);res.status(500).json({error:'Login service unavailable'});}
});

app.get('/api/me', async (req,res)=>{
  try{
    const u=await authUser(req); if(!u)return res.status(401).json({error:'Not logged in'});
    const r=await pool.query('SELECT gems,gold,shards,inventory FROM player_data WHERE account_id=$1',[u.id]);
    res.json({user:u,data:r.rows[0]});
  }catch(e){res.status(500).json({error:'Could not load player data'});}
});

app.post('/api/economy/sync', async (req,res)=>{
  // Migration helper: accepts an inventory only once when the server inventory is empty.
  try{
    const u=await authUser(req); if(!u)return res.status(401).json({error:'Not logged in'});
    const incoming=cleanInventory(req.body?.inventory);
    const r=await pool.query('SELECT inventory FROM player_data WHERE account_id=$1',[u.id]);
    const existing=cleanInventory(r.rows[0]?.inventory);
    if(Object.keys(existing).length===0 && Object.keys(incoming).length){
      await pool.query('UPDATE player_data SET inventory=$1 WHERE account_id=$2',[JSON.stringify(incoming),u.id]);
    }
    const now=await pool.query('SELECT gems,gold,shards,inventory FROM player_data WHERE account_id=$1',[u.id]);
    res.json({ok:true,data:now.rows[0]});
  }catch(e){res.status(500).json({error:'Could not sync inventory'});}
});

app.get('/api/trades', async (req,res)=>{
  try{
    const u=await authUser(req); if(!u)return res.status(401).json({error:'Not logged in'});
    const r=await pool.query(
      `SELECT t.id,t.offer,t.request,t.status,t.created_at,a.username AS from_username,b.username AS to_username
       FROM trades_secure t JOIN accounts a ON a.id=t.from_user JOIN accounts b ON b.id=t.to_user
       WHERE (t.from_user=$1 OR t.to_user=$1) AND t.status='pending'
       ORDER BY t.created_at DESC`,[u.id]);
    res.json({trades:r.rows});
  }catch(e){res.status(500).json({error:'Could not load trades'});}
});

app.post('/api/trades', async (req,res)=>{
  try{
    const u=await authUser(req); if(!u)return res.status(401).json({error:'Not logged in'});
    const {toUsername,offer,request}=req.body||{};
    if(!toUsername||!offer?.unit||!request?.unit)return res.status(400).json({error:'Trade contents missing'});
    const b=await pool.query('SELECT id,username FROM accounts WHERE LOWER(username)=LOWER($1)',[toUsername]);
    if(!b.rows.length)return res.status(404).json({error:'Account not found'});
    if(b.rows[0].id===u.id)return res.status(400).json({error:'You cannot trade with yourself'});
    const count=Math.max(1,Math.floor(Number(offer.count)||1));
    const invR=await pool.query('SELECT inventory FROM player_data WHERE account_id=$1 FOR UPDATE',[u.id]);
    const inv=cleanInventory(invR.rows[0]?.inventory);
    if((inv[offer.unit]||0)<count)return res.status(400).json({error:'You do not own enough copies'});
    // Reserve offered units immediately so they cannot be traded twice.
    inv[offer.unit]-=count; if(inv[offer.unit]<=0)delete inv[offer.unit];
    await pool.query('UPDATE player_data SET inventory=$1 WHERE account_id=$2',[JSON.stringify(inv),u.id]);
    const r=await pool.query(
      `INSERT INTO trades_secure(from_user,to_user,offer,request) VALUES($1,$2,$3,$4) RETURNING id`,
      [u.id,b.rows[0].id,JSON.stringify({unit:offer.unit,count}),JSON.stringify({unit:request.unit,count:Math.max(1,Math.floor(Number(request.count)||1))})]);
    res.json({ok:true,tradeId:r.rows[0].id});
  }catch(e){console.error(e);res.status(500).json({error:'Could not create trade'});}
});

app.post('/api/trades/:id/decline', async (req,res)=>{
  const client=await pool.connect();
  try{
    const u=await authUser(req); if(!u)return res.status(401).json({error:'Not logged in'});
    await client.query('BEGIN');
    const q=await client.query('SELECT * FROM trades_secure WHERE id=$1 AND to_user=$2 AND status=$3 FOR UPDATE',[Number(req.params.id),u.id,'pending']);
    if(!q.rows.length){await client.query('ROLLBACK');return res.status(404).json({error:'Trade unavailable'});}
    const t=q.rows[0];
    const invQ=await client.query('SELECT inventory FROM player_data WHERE account_id=$1 FOR UPDATE',[t.from_user]);
    const inv=cleanInventory(invQ.rows[0].inventory);
    inv[t.offer.unit]=(inv[t.offer.unit]||0)+Number(t.offer.count||1);
    await client.query('UPDATE player_data SET inventory=$1 WHERE account_id=$2',[JSON.stringify(inv),t.from_user]);
    await client.query('UPDATE trades_secure SET status=$1 WHERE id=$2',['declined',t.id]);
    await client.query('COMMIT'); res.json({ok:true});
  }catch(e){await client.query('ROLLBACK');res.status(500).json({error:'Could not decline trade'});}
  finally{client.release();}
});

app.post('/api/trades/:id/accept', async (req,res)=>{
  const client=await pool.connect();
  try{
    const u=await authUser(req); if(!u)return res.status(401).json({error:'Not logged in'});
    await client.query('BEGIN');
    const q=await client.query('SELECT * FROM trades_secure WHERE id=$1 AND to_user=$2 AND status=$3 FOR UPDATE',[Number(req.params.id),u.id,'pending']);
    if(!q.rows.length){await client.query('ROLLBACK');return res.status(404).json({error:'Trade unavailable'});}
    const t=q.rows[0], reqUnit=t.request.unit, reqCount=Number(t.request.count||1);
    const invQ=await client.query('SELECT inventory FROM player_data WHERE account_id=$1 FOR UPDATE',[u.id]);
    const inv=cleanInventory(invQ.rows[0].inventory);
    if((inv[reqUnit]||0)<reqCount){
      // Return the reserved offer to the sender.
      const senderQ=await client.query('SELECT inventory FROM player_data WHERE account_id=$1 FOR UPDATE',[t.from_user]);
      const sender=cleanInventory(senderQ.rows[0].inventory);
      sender[t.offer.unit]=(sender[t.offer.unit]||0)+Number(t.offer.count||1);
      await client.query('UPDATE player_data SET inventory=$1 WHERE account_id=$2',[JSON.stringify(sender),t.from_user]);
      await client.query('UPDATE trades_secure SET status=$1 WHERE id=$2',['declined',t.id]);
      await client.query('COMMIT');
      return res.status(400).json({error:'You do not own the requested units. The offer was returned.'});
    }
    inv[reqUnit]-=reqCount;if(inv[reqUnit]<=0)delete inv[reqUnit];
    inv[t.offer.unit]=(inv[t.offer.unit]||0)+Number(t.offer.count||1);
    await client.query('UPDATE player_data SET inventory=$1 WHERE account_id=$2',[JSON.stringify(inv),u.id]);
    const senderQ=await client.query('SELECT inventory FROM player_data WHERE account_id=$1 FOR UPDATE',[t.from_user]);
    const sender=cleanInventory(senderQ.rows[0].inventory);
    sender[reqUnit]=(sender[reqUnit]||0)+reqCount;
    await client.query('UPDATE player_data SET inventory=$1 WHERE account_id=$2',[JSON.stringify(sender),t.from_user]);
    await client.query('UPDATE trades_secure SET status=$1 WHERE id=$2',['accepted',t.id]);
    await client.query('COMMIT'); res.json({ok:true});
  }catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({error:'Could not accept trade'});}
  finally{client.release();}
});
