# BIOS2026 LocalFirst

LocalFirst is a self-hosted office suite for documents, spreadsheets, slides,
whiteboards, and PDFs, with offline and nearby collaboration features.
The application source is in [`diwan/`](diwan/). See the
[application README](diwan/README.md), [user guide](diwan/docs/USER-GUIDE.md),
and [architecture](diwan/docs/ARCHITECTURE.md).

## Build and run

Install Node.js 22.12+ (or a newer supported release), npm, and Go as specified
in [`diwan/go.mod`](diwan/go.mod). Keep the npm and Go lockfiles when installing
dependencies.

On Windows, from this directory:

```powershell
.\Build-Diwan.ps1
.\Start-Diwan.ps1
```

The launcher opens http://127.0.0.1:8080 and creates `diwan/windows.local`
from [`windows.local.example`](diwan/windows.local.example) if needed.
This configuration listens only on localhost. The build uses Go on PATH or
an existing portable toolchain at `.tools/go/bin/go.exe`.

On other platforms:

```sh
cd diwan/web
npm ci
npm run build:frontend
cd ..
go build -o localfirst .
cp windows.local.example windows.local
./localfirst -config windows.local
```

Build the frontend before running the server to embed the full interface.
`diwan/dist/.gitkeep` is retained so Go can compile before a frontend build.
For portable offline packages, run `npm run build:offline` followed by
`npm run package:offline` from `diwan/web`;
see the [offline progress notes](diwan/docs/OFFLINE-NEARBY-PROGRESS.md).

## Configuration and local files

The checked-in [`config.yaml`](diwan/config.yaml) contains defaults only.
Keep private configuration in ignored `*.local` files. For optional browser
build settings, copy [`diwan/web/.env.example`](diwan/web/.env.example) to
`diwan/web/.env.local`. Every `VITE_*` value is visible to browser users.
The Go server reads environment variables from its process; it does not load
`.env` files automatically. See the
[configuration reference](diwan/docs/CONFIGURATION.md) and
[Vercel/Railway guide](diwan/docs/VERCEL-RAILWAY.md) for server secrets and hosting.

Git excludes environment files, credentials, local databases, uploads, logs,
downloaded SDKs under `.tools/`, `Diwan-Cloud/` runtime state, dependency folders,
build/package output, and local verification reports. These files stay on disk.
Three sanitized historical reports linked by the judging guide are retained.
The source, tests, scripts, documentation, licenses, and dependency lockfiles
are included. Existing cloud-launch and hardware verification scripts require
their own local tools and account setup.

## Checks

```sh
cd diwan/web
npm test
npm run build:frontend
cd ..
go test -short ./...
go build ./...
```

Licensed under [MIT](diwan/LICENSE-MIT) or [Apache-2.0](diwan/LICENSE-APACHE).
Upstream authorship and third-party notices are preserved in `diwan/`.
