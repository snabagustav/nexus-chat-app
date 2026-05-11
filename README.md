# Nexus Chat App

Complete production folder for Railway.

Use this folder as the whole GitHub repo. Do not put it inside another `chatapp`
folder.

Required Railway variables:

- `JWT_SECRET`
- `NODE_ENV=production`
- `ADMIN_PIN_HASH`

The admin PIN is not stored in this repository. Set `ADMIN_PIN_HASH` in Railway
Variables. The PIN itself is checked only on the server.

Admin flow:

1. Log in to the app.
2. Click the `A` button in the left rail.
3. Enter your 4 digit PIN.
4. The admin page opens at `/admin.html`.

Theme flow:

1. Click the `T` button in the left rail.
2. Pick a theme.
3. The theme is saved in the browser and on your account while the server is running.

Railway:

- Source repo: `snabagustav/nexus-chat-app`
- Branch: `main`
- Root directory: leave empty
- Start command comes from `railway.toml`
