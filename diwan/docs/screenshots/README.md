# Current LocalFirst screenshots

Real screenshots of the offline build at 1440 × 900, with a 2× device scale, in light and dark themes.
The gallery uses fabricated sample files in a fresh browser profile. Existing user data is never opened.

From `web/`, run:

```sh
npm run build:offline
npm run screenshots:offline
```

Requires Playwright and Google Chrome. The script starts and stops its own loopback preview server.
Each editor must load its sample content before capture; browser runtime errors fail the run.

- home-light.png
- apphome-docs-light.png
- docs-editor-light.png
- sheets-editor-light.png
- slides-editor-light.png
- whiteboard-editor-light.png
- pdf-editor-light.png
- settings-light.png
- home-dark.png
- apphome-docs-dark.png
- docs-editor-dark.png
- sheets-editor-dark.png
- slides-editor-dark.png
- whiteboard-editor-dark.png
- pdf-editor-dark.png
- settings-dark.png
