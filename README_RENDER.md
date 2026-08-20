# Bastion TD Online — Real-Time VS

## Render deployment
1. Create a PostgreSQL database on Render and copy its Internal Database URL into `DATABASE_URL`.
2. Create a Web Service from this folder/repo.
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add `JWT_SECRET` with a long random value.
6. Seed the eight accounts by running `node seed-accounts.js` with `BASTION_PASSWORDS` set to a JSON object containing passwords for Hunter, lj, val, arthur, ben, david, zane, jonah.

The frontend is served by the same service. Real-time VS uses WebSockets at `/ws`; Render Web Services support WebSocket connections.

The current VS layer is a synchronized online arena: players can challenge each other, ready up, send enemy types, damage bases, and receive match-end state in real time. It is intentionally separate from the existing single-player wave simulation so the original campaign remains intact.
