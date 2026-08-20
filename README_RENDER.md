# Bastion TD Online — Render Deployment

## What this package includes
- Bastion TD served directly at `/` (no `Cannot GET /`).
- Eight fixed accounts: Hunter, lj, val, arthur, ben, david, zane, jonah.
- PostgreSQL-backed player data.
- Secure bcrypt password hashes and JWT login sessions.
- Server-validated trade offers for gems, shards, and owned units.
- Persistent trade history.
- Persistent VS challenges plus real-time WebSocket battle state.
- VS wins award 100 gold to the winner; losses are recorded.

## Render setup
1. Create a PostgreSQL database on Render.
2. Create a Web Service from this repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variable `DATABASE_URL` using the database's Internal Database URL.
6. Add environment variable `JWT_SECRET` with a long random secret.
7. Deploy.

## Initialize the eight accounts
The accounts are intentionally not given passwords in the repository. Set `BASTION_PASSWORDS` only when running the one-time seed command, for example from a secure local shell or Render Shell. It must be a JSON object with exactly these usernames as needed:

`{"Hunter":"...","lj":"...","val":"...","arthur":"...","ben":"...","david":"...","zane":"...","jonah":"..."}`

Then run:

`node seed-accounts.js`

Do not commit passwords, `BASTION_PASSWORDS`, `JWT_SECRET`, or database credentials to GitHub.

## Health check
After deployment, open `/api/health`. It should return JSON with `ok: true`.

## Notes
The campaign remains separate from the online VS arena. The current VS battle is a synchronized prototype: players ready up, send enemies, enemies reach bases, and the server records the winner. The existing single-player tower/wave engine is not yet synchronized across clients.

## Initialize the 8 accounts securely

Do **not** put the account passwords in GitHub.

In Render, add an environment variable named `BASTION_PASSWORDS`. Its value should be a JSON object containing the passwords you chose for the eight usernames. Keep this variable only in Render.

After `DATABASE_URL`, `JWT_SECRET`, and `BASTION_PASSWORDS` are saved, open the Render Shell and run:

```bash
npm run seed
```

This hashes the passwords with bcrypt and stores only the hashes in Neon. You can remove `BASTION_PASSWORDS` from Render afterward if you do not need to reseed/reset the accounts.
