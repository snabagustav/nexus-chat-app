# ✦ NEXUS — Setup Guide
# Chat · Voice Calls · Games
# ─────────────────────────────────────────────────────────────────────

## What you get
- 💬 Real-time chat rooms (General, Gaming, Music, Random)
- 📞 Voice & video calls with room sharing
- 🎮 Chess, Tic-Tac-Toe, Connect Four (multiplayer)
- 🔐 Sign up with email, Google, or anonymous (name required)

## STEP 1 — Install Node.js (free, 2 min)
1. Go to https://nodejs.org
2. Download and install the "LTS" version
3. That's it

## STEP 2 — Run the app (no config needed for basic use)
1. Open a terminal / command prompt in this folder
2. Run:
       npm install
       npm start
3. Open http://localhost:3000 in your browser
4. Done — the app works! Email signup and anonymous work immediately.

## STEP 3 — Add Google Sign-In (free, 5 min)
1. Go to https://console.cloud.google.com
2. Click "New Project" → give it any name → Create
3. Go to "APIs & Services" → "OAuth consent screen"
   - Choose "External" → Fill in app name → Save
4. Go to "Credentials" → "+ Create Credentials" → "OAuth 2.0 Client IDs"
   - Application type: Web application
   - Authorized JavaScript origins: http://localhost:3000
   - Click Create → Copy the "Client ID"
5. Open public/index.html
6. Find: data-client_id="REPLACE_WITH_YOUR_GOOGLE_CLIENT_ID"
7. Replace with your actual Client ID

## STEP 4 — Make it accessible to others on your network
Your app already works for anyone on the same WiFi at:
   http://YOUR_IP_ADDRESS:3000

Find your IP:
- Windows: open cmd → type: ipconfig → look for IPv4 Address
- Mac/Linux: open terminal → type: ifconfig | grep inet

## STEP 5 — Host it on the internet for FREE (15 min)

### Option A: Railway (easiest)
1. Go to https://railway.app → Sign up free
2. Click "New Project" → "Deploy from GitHub"
   - Or use "Deploy from local" and upload this folder
3. Railway auto-detects Node.js and deploys
4. You get a free URL like: https://nexus-xxx.railway.app
5. Set environment variables in Railway dashboard (Settings → Variables):
   JWT_SECRET=any_long_random_string
   GOOGLE_CLIENT_ID=your_google_client_id (if using Google)

### Option B: Render (also free)
1. Go to https://render.com → Sign up free
2. New → Web Service → connect your code
3. Build command: npm install
4. Start command: npm start
5. Add environment variables in dashboard

### Option C: Fly.io (free tier)
1. Install flyctl: https://fly.io/docs/hands-on/install-flyctl/
2. Run: fly launch
3. Run: fly deploy

## ENVIRONMENT VARIABLES (only needed for production)
Copy .env.example to .env and fill in:

   JWT_SECRET        → any long random string (required)
   PORT              → 3000 (default)
   GOOGLE_CLIENT_ID  → from Google Console (optional)

For local use you don't need a .env file at all — defaults work.

## HOW TO USE

### Chat
- Click any room in the left sidebar to join
- Type and press Enter to send messages
- Click 📞 in the chat header to start a voice call

### Calls  
- Click the "Calls" tab
- Click "Join Call" (leave ID blank to create a new call)
- Share the Call ID shown with friends so they can join
- Use the microphone/camera buttons to toggle

### Games
- Click the "Games" tab
- Click "Create Game" for Chess, Tic-Tac-Toe, or Connect Four
- Share the Game ID with a friend
- They enter the Game ID and click "Join Game →"

## TROUBLESHOOTING

Problem: "Cannot find module" error
Solution: Run `npm install` first

Problem: Port 3000 in use
Solution: Change PORT=3001 in .env

Problem: Google sign-in not working
Solution: Make sure your Client ID is set in index.html AND
          http://localhost:3000 is in your Google OAuth origins

Problem: Calls not connecting
Solution: The app uses Google STUN servers (free) and Open Relay
          TURN servers (free). These work for most networks.
          If behind a strict firewall, set up your own TURN server.

## NOTES
- All chat messages and user accounts are stored in memory
- Restarting the server clears all data (users, messages, games)
- For persistent storage, add a database (MongoDB Atlas is free)
- The app supports unlimited simultaneous users and rooms
