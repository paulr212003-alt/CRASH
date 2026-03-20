# RICO Visitor Portal Deployment

This project now supports both:

1. Render with a long-running Node server
2. Vercel with static files in `public/` and a serverless Express entrypoint

## What is already prepared in code
1. `Frontend/script.js` uses same-origin API calls (`/api`).
2. `Backend/app.js` exports the Express app so Vercel can run it.
3. `Backend/server.js` still starts the long-running Node server for local use or Render.
4. `Backend/db.js` reuses the MongoDB connection across requests, which is important for serverless hosting.
5. `scripts/sync-public.js` copies `Frontend/` into `public/` during the build step for Vercel.
6. `vercel.json` tells Vercel to run the static sync build.
7. `package.json` enforces Node `>=20.19.0` (required by `mongoose@9`).

## Required environment variables
Set these in Render or Vercel:

`MONGO_URI=<your Atlas URI with /visitorDB>`
`ADMIN_PASSWORD=<strong password>`
`CORS_ORIGINS=https://<your-production-domain>`

Backward-compatible fallback also works:
`CORS_ORIGIN=https://<your-production-domain>`

If you leave `CORS_ORIGINS` empty, the server allows all origins. That is okay for quick testing, but not ideal for production.

## MongoDB Atlas checklist
1. In `Database Access`, create or update a database user.
2. In `Network Access`, add the correct IP access. For public cloud hosting this is often `0.0.0.0/0`.
3. Use database name `visitorDB` in the connection string.

## Vercel deployment
1. Push this repo to GitHub.
2. In Vercel, click `Add New` -> `Project`.
3. Import the GitHub repo.
4. Set the environment variables listed above.
5. Deploy.

### What Vercel uses
1. `npm run build` copies `Frontend/` to `public/`.
2. Static pages are served from `public/`.
3. API and health routes run through the root `index.js` Express export.

## Render deployment
1. Push this repo to GitHub.
2. In Render, click `New` -> `Blueprint`.
3. Select your GitHub repo.
4. Render reads `render.yaml`.
5. Set the environment variables listed above.
6. Deploy.

## Atlas URI format
Use this format:

`mongodb+srv://<db_username>:<db_password>@<cluster-host>/visitorDB?retryWrites=true&w=majority&appName=<cluster-name>`

## Verification checklist after deploy
1. `/health` returns JSON with `"status":"ok"`.
2. Home page loads without console errors.
3. Creating a pass saves data to Atlas `visitorDB`.
4. Renew pass, validate pass, mark exit, history, and active-pass recovery all work.

## Common issues
1. `MongooseServerSelectionError`: Atlas IP access list is missing or incorrect.
2. `Authentication failed`: wrong Atlas username/password in `MONGO_URI`.
3. API failures in production: `CORS_ORIGINS` does not include the deployed domain.
4. Build/runtime errors: ensure the host uses Node `20.19.0` or higher.
