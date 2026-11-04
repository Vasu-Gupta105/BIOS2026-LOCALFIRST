Diwan is installed in the `diwan` folder.

- Open http://127.0.0.1:8080 while the server is running.
- Double-click `Start-Diwan.cmd` to start the server and open your browser.
- Documents and application data are stored in `diwan/data`; uploads are in `diwan/uploads`.
- Server logs are in `diwan/logs`.
- The local configuration is `diwan/windows.local`. It listens only on this computer and requires no login.
- Stop the server with `Get-Process diwan | Stop-Process` in PowerShell.

To rebuild from source, stop the server, then run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Build-Diwan.ps1
```

Install Go on PATH, or use an existing portable Go SDK in `.tools/go` (ignored by Git). Node.js and npm use the machine's existing installation. The launcher creates the ignored `diwan/windows.local` from `diwan/windows.local.example` on first launch.

Two Windows setup fixes are included: npm 12 can install the explicit SheetJS URL dependency, and the notices generator invokes its JavaScript CLI with Node rather than a Unix shell shim.
