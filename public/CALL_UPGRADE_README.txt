This upgrade is for the final Nexus Chat App structure.

Copy these files into your project and replace:

public/css/call-discord.css
public/js/call-discord.js

Then add these two lines to public/index.html:

Before </head>:
<link rel="stylesheet" href="/css/call-discord.css">

Before </body>, after /js/app.js:
<script src="/js/call-discord.js"></script>

If you want zero manual editing, ask Codex to create a full folder again.
