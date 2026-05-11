# Nexus Chat App Mega

Clean full build for Railway.

Features:

- persistent JSON database
- accounts, Google, anonymous login
- chat rooms, private rooms, invites
- friends and direct messages
- reactions, mentions, browser notifications
- profile pictures, bio, status, banner, custom themes
- fullscreen Discord-style calls, screen share, device picker, push-to-talk
- admin panel with users, rooms, logs, mutes, bans, moderators
- games: Tic Tac Toe, Connect Four, Rock Paper Scissors, Memory, Trivia, Checkers
- swear filter with cooldown for non-admins/non-mods

Required Railway variables:

- `JWT_SECRET`
- `NODE_ENV=production`
- `ADMIN_PIN_HASH`

The admin PIN is not stored in GitHub. Use the secure hash in Railway Variables.

Admin flow:

1. Log in.
2. Click `Admin`.
3. Enter your PIN.
4. Admin panel opens.

Railway:

- repo: `snabagustav/nexus-chat-app`
- branch: `main`
- root directory: empty
