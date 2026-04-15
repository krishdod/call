# Free Calling App (Internet Calls, No Paid Number)

This app works like WhatsApp/Telegram calling: each user picks a **username**, sees online contacts, and tap-to-call over the internet (WebRTC audio).

## Stack

- Frontend: React + Vite
- Backend: Node.js + Express + Socket.IO
- Media: WebRTC (audio only)

## Run locally

### 1) Start backend

```bash
cd backend
npm install
npm run dev
```

Backend runs on `http://localhost:4000`.

### 2) Start frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on `http://localhost:5173`.

## How to test

1. Open the app in **two** browser tabs or windows.
2. Tab A: enter a name and username (e.g. `alex_01`), tap **Continue**.
3. Tab B: different name and username (e.g. `sam_02`), tap **Continue**.
4. On Tab A, select `sam_02` from online users and tap the green **Call** button.
5. Tab B should show **incoming call** — tap **Answer**.
6. Allow the microphone when the browser asks. Talk, then tap **End**.

Use **Refresh** under recent activity to load call history for your username.

## Notes

- Usernames are **only IDs inside this app**, not real phone lines.
- This is free for browser-to-browser calls.
- Calling real PSTN numbers needs a paid provider later if you add that.

## Share with other users (free deploy)

To let other people test as receiver, deploy backend + frontend and share the frontend URL.

### 1) Deploy backend on Render

1. Push this project to GitHub.
2. In Render, click **New +** -> **Blueprint**.
3. Connect your GitHub repo and select it.
4. Render will read `render.yaml` and create the backend service from `backend/`.
5. Wait for deploy, then copy backend URL (example: `https://free-calling-backend.onrender.com`).
6. Open `https://your-backend-url/health` and confirm `{"ok":true}`.

### 2) Deploy frontend on Vercel

1. In Vercel, click **Add New** -> **Project** and import the same repo.
2. (Recommended) Set **Root Directory** to `frontend`.
   - If you deploy from repo root, this repo also includes `vercel.json` so it still builds the `frontend/` app.
3. Add environment variable:
   - `VITE_SIGNALING_URL` = your Render backend URL
4. Deploy project.
5. Redeploy frontend if you later change backend URL.

### 3) Share and test

1. Send your Vercel frontend URL to the other user.
2. Both users open the same URL, register with different usernames, allow microphone.
3. Caller selects receiver from online users and taps **Call**.

## Troubleshooting

- If users cannot see each other, check both are on same frontend URL and backend is awake.
- Render free services can sleep; first request may take ~30-60s.
- If calls fail, verify `VITE_SIGNALING_URL` is set correctly in Vercel and redeploy.

## One codebase: mobile + desktop

The `frontend/` app is now set up to be packaged for both mobile (Capacitor) and desktop (Electron) while reusing the same React code.

### Root shortcut commands

From repo root:

```bash
npm install
npm run dev
```

Other root-level shortcuts:

```bash
npm run mobile:prepare
npm run desktop:dev
npm run desktop:build
```

### Mobile first (Capacitor)

From `frontend/`:

```bash
npm run mobile:prepare
```

Then add/open native projects:

```bash
npm run cap:add:android
npx cap open android
```

For iOS (requires macOS + Xcode):

```bash
npm run cap:add:ios
npx cap open ios
```

After frontend changes, rebuild + sync:

```bash
npm run mobile:prepare
```

### Desktop (Electron)

From `frontend/`:

```bash
npm run desktop:dev
```

Create distributable app build:

```bash
npm run desktop:dist
```

### Backend URL handling for web/mobile/desktop

- If `VITE_SIGNALING_URL` is set in `frontend/.env`, it is always used.
- On localhost dev, app defaults to `http://localhost:4000`.
- For packaged/mobile/desktop builds without `VITE_SIGNALING_URL`, the setup screen shows a **Signaling server URL** field and saves it for next launches.
- For production builds, set `VITE_SIGNALING_URL` before building to avoid manual entry.

## Why the first load can feel slow

- **Vercel** serves the JS bundle; the first visit downloads and parses it (normal).
- **Render** free tier may **cold-start** the API: the first socket connection after idle can take 30–60 seconds.
- The app **loads the real-time library only after you tap Continue**, so the landing screen should feel lighter.
- After one visit, repeat loads are usually faster (browser cache + warm backend).

### Auto-wake backend on open

When someone opens the app, the frontend immediately requests `GET {VITE_SIGNALING_URL}/health` in the background so a sleeping Render instance starts waking **as soon as the page loads** (before you tap Continue). It does not guarantee instant readiness, but it overlaps cold start with loading the UI.
