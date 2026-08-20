import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import path from 'path';
import {fileURLToPath} from 'url';
import {WebSocketServer} from 'ws';

const {Pool}=pg;
const app=express();
app.use(cors()); app.use(express.json());
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL?{rejectUnauthorized:false}:false});
const JWT_SECRET=process.env.JWT_SECRET || 'CHANGE_ME_ON_RENDER';
const ACCOUNTS=['Hunter','lj','val','arthur','ben','david','zane','jonah'];
const clean=s=>String(s||'').trim();
async function db(){await pool.query(`CREATE TABLE IF NOT EXISTS players(id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, gems INTEGER NOT NULL DEFAULT 2500, gold INTEGER NOT NULL DEFAULT 150, shards INTEGER NOT NULL DEFAULT 0, collection JSONB NOT NULL DEFAULT '{}'::jsonb, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS trades(id SERIAL PRIMARY KEY, from_user TEXT NOT NULL, to_user TEXT NOT NULL, offer JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT now());`)}
function auth(req,res,next){try{const t=(req.headers.authorization||'').replace('Bearer ','');req.user=jwt.verify(t,JWT_SECRET);next()}catch{res.status(401).json({error:'Unauthorized'})}}
app.get('/api/health',(_,res)=>res.json({ok:true}));
app.get('/api/accounts',(_,res)=>res.json({accounts:ACCOUNTS}));
app.post('/api/login',async(req,res)=>{const u=clean(req.body.username);const p=String(req.body.password||'');if(!ACCOUNTS.includes(u)||!p)return res.status(401).json({error:'Invalid login'});const q=await pool.query('SELECT * FROM players WHERE username=$1',[u]);if(!q.rowCount)return res.status(401).json({error:'Account not initialized'});if(!(await bcrypt.compare(p,q.rows[0].password_hash)))return res.status(401).json({error:'Invalid login'});res.json({token:jwt.sign({username:u},JWT_SECRET,{expiresIn:'7d'}),player:publicPlayer(q.rows[0])})});
app.get('/api/me',auth,async(req,res)=>{const q=await pool.query('SELECT * FROM players WHERE username=$1',[req.user.username]);res.json(publicPlayer(q.rows[0]))});
app.get('/api/players',auth,(_,res)=>res.json({players:ACCOUNTS}));
app.post('/api/trades',auth,async(req,res)=>{const to=clean(req.body.to);const offer=req.body.offer||{};if(!ACCOUNTS.includes(to)||to===req.user.username)return res.status(400).json({error:'Invalid recipient'});const q=await pool.query('INSERT INTO trades(from_user,to_user,offer) VALUES($1,$2,$3) RETURNING *',[req.user.username,to,JSON.stringify(offer)]);res.json(q.rows[0])});
app.get('/api/trades',auth,async(req,res)=>{const q=await pool.query('SELECT * FROM trades WHERE from_user=$1 OR to_user=$1 ORDER BY id DESC',[req.user.username]);res.json(q.rows)});
app.post('/api/trades/:id/respond',auth,async(req,res)=>{const status=['accepted','declined'].includes(req.body.status)?req.body.status:null;if(!status)return res.status(400).json({error:'Bad status'});const q=await pool.query('UPDATE trades SET status=$1 WHERE id=$2 AND to_user=$3 RETURNING *',[status,req.params.id,req.user.username]);if(!q.rowCount)return res.status(404).json({error:'Trade not found'});res.json(q.rows[0])});
app.post('/api/vs/challenge',auth,async(req,res)=>{const opponent=clean(req.body.opponent);if(!ACCOUNTS.includes(opponent)||opponent===req.user.username)return res.status(400).json({error:'Invalid opponent'});res.json({status:'challenge-created',from:req.user.username,to:opponent});});
function publicPlayer(p){return {username:p.username,gems:p.gems,gold:p.gold,shards:p.shards,collection:p.collection,wins:p.wins,losses:p.losses}}
app.use(express.static(__dirname));
const port=process.env.PORT||3000;
const matches=new Map();
const sockets=new Map();
function send(ws,msg){if(ws && ws.readyState===1)ws.send(JSON.stringify(msg))}
function broadcast(match,msg){for(const username of [match.p1,match.p2])send(sockets.get(username),msg)}
function newMatch(p1,p2){const id='m_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);const m={id,p1,p2,hp:{[p1]:100,[p2]:100},gold:{[p1]:500,[p2]:500},wave:1,started:false,ended:false,units:[]};matches.set(id,m);return m}
function resolvePendingChallenge(from,to){return null}

const httpServer=await new Promise((resolve,reject)=>{const s=app.listen(port,()=>resolve(s));s.on('error',reject)});
const wss=new WebSocketServer({server:httpServer,path:'/ws'});
wss.on('connection',(ws)=>{
  let username=null, matchId=null;
  ws.on('message',raw=>{
    try{
      const msg=JSON.parse(raw.toString());
      if(msg.type==='auth'){
        try{const user=jwt.verify(String(msg.token||''),JWT_SECRET).username;if(!ACCOUNTS.includes(user))throw new Error();username=user;sockets.set(username,ws);send(ws,{type:'authed',username});}
        catch{send(ws,{type:'error',error:'WebSocket authentication failed'});ws.close()}
        return;
      }
      if(!username)return send(ws,{type:'error',error:'Authenticate first'});
      if(msg.type==='create_match'){
        const opponent=clean(msg.opponent);if(!ACCOUNTS.includes(opponent)||opponent===username)return send(ws,{type:'error',error:'Invalid opponent'});
        const existing=[...matches.values()].find(m=>!m.ended&&((m.p1===username&&m.p2===opponent)||(m.p1===opponent&&m.p2===username)));
        const m=existing||newMatch(username,opponent);matchId=m.id;
        send(ws,{type:'match_created',match:m});send(sockets.get(opponent),{type:'incoming_match',match:m});return;
      }
      const m=matches.get(msg.matchId||matchId);if(!m)return send(ws,{type:'error',error:'Match not found'});
      if(username!==m.p1&&username!==m.p2)return send(ws,{type:'error',error:'Not in match'});
      matchId=m.id;
      if(msg.type==='ready'){m.started=true;broadcast(m,{type:'match_started',match:m});return;}
      if(msg.type==='send_enemy'){
        if(m.ended)return;
        const target=username===m.p1?m.p2:m.p1;const cost=Math.max(20,20+(msg.tier||0)*15);if(m.gold[username]<cost)return send(ws,{type:'error',error:'Not enough gold'});
        m.gold[username]-=cost;const enemy={id:Date.now()+Math.random(),from:username,target,type:['Goblin','Runner','Brute','Wraith'][(msg.tier||0)%4],tier:msg.tier||0,hp:20+(msg.tier||0)*30};m.units.push(enemy);broadcast(m,{type:'enemy_sent',enemy,gold:m.gold});return;
      }
      if(msg.type==='damage_enemy'){
        const enemy=m.units.find(x=>String(x.id)===String(msg.enemyId)&&x.target===username);if(!enemy)return;
        enemy.hp-=Math.max(1,Number(msg.damage)||1);if(enemy.hp<=0)m.units=m.units.filter(x=>x!==enemy);broadcast(m,{type:'enemy_damaged',enemyId:msg.enemyId,remaining:Math.max(0,enemy.hp)});return;
      }
      if(msg.type==='damage_base'){
        const amount=Math.max(1,Math.min(25,Number(msg.amount)||1));m.hp[username]-=amount;if(m.hp[username]<=0){m.hp[username]=0;m.ended=true;const winner=username===m.p1?m.p2:m.p1;broadcast(m,{type:'match_ended',winner,loser:username,hp:m.hp});}
        else broadcast(m,{type:'base_damaged',player:username,hp:m.hp[username]});return;
      }
      if(msg.type==='leave'){m.ended=true;const winner=username===m.p1?m.p2:m.p1;broadcast(m,{type:'match_ended',winner,loser:username,hp:m.hp});}
    }catch(e){send(ws,{type:'error',error:'Invalid message'})}
  });
  ws.on('close',()=>{if(username&&sockets.get(username)===ws)sockets.delete(username)});
});
console.log('Bastion online on '+port+' with real-time VS WebSocket');
