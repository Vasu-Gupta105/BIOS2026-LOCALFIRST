Diwan is deployed at https://diwan-phi.vercel.app.

Vercel serves the browser app. A free Cloudflare Quick Tunnel connects it to the authenticated Go backend on this PC at 127.0.0.1:8081.

## Open and sign in

Open the deployed URL. Double-click `Show-Diwan-Cloud-Login.cmd` to display the login password. The password and JWT secret are stored with Windows user encryption in `Diwan-Cloud/secrets.clixml`.

## Keep it running

Keep this PC online and awake. The backend and tunnel run as hidden processes.

After a restart, double-click `Start-Diwan-Cloud.cmd`. It starts the backend and tunnel, checks their health, and updates Vercel's API rewrites for the tunnel's new temporary URL. It requires your existing Vercel CLI login. The Vercel website address remains the same.

## Documents and backups

Cloud-instance records are saved in `Diwan-Cloud/data`; uploads are saved in `Diwan-Cloud/uploads`.

The initial cloud instance contains a snapshot of the four existing local documents, with the original IDs and version records. SQLite databases were copied using SQLite's online backup API and checked for integrity.

Use the hosted site for future cloud-instance edits. The original localhost:8080 instance has its own data directory; later edits are not automatically copied between the two instances.

Runtime information is in `Diwan-Cloud/state.json`, and process logs are in `Diwan-Cloud/logs`.

## Verification and known limitation

`Diwan-published-verification.json` records successful checks of public endpoint access, login, closed anonymous registration, disabled browsing of the server's personal folders, existing documents, document creation/autosave/reload, and two-browser real-time collaboration. The verification document was removed afterward.

The previously identified offline-refresh and retry problems are still present. Offline refresh can lose an unsaved draft; reconnecting after save retries expire does not automatically flush pending changes. See `Diwan-offline-realtime-results.md`.

Cloudflare Quick Tunnels are temporary development tunnels without an uptime guarantee. A stable tunnel independent of this PC would require another hosting setup.
