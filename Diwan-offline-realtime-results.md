Diwan offline and real-time verification
======================================

Tested the installed Windows Diwan executable with an isolated real Go server, temporary documents, and two independent Chrome browser contexts. API responses were not mocked. The existing local app uses the default update-log setting (disabled), which was also used in these checks.

Passed:
- Real WebRTC co-editing in both directions. Host-to-host candidate pairs were observed. End-to-end checks, including typing, completed in 756 ms and 657 ms on this machine.
- Existing peer connections continued to synchronize edits while browser HTTP access was offline. The server copy stayed unchanged during the outage, and a local draft was written.
- After closing peer connections and editing separately, both edits merged automatically after reconnection in approximately 4.3 seconds. Both browsers converged to the same text.
- Editing an already-open document offline wrote the unsaved content to IndexedDB.

Failed:
- Reconnecting after the configured save retries had expired did not automatically save the offline edit during a 10-second observation window. The server retained its previous content.
- Refreshing a previously opened document while fully offline did not reopen the editable document.
- Offline refresh and subsequent recovery did not preserve the test edit: the IndexedDB draft existed after returning online, but no longer contained the unsaved marker. This was reproduced in a targeted recovery check.

Conclusion: real-time document collaboration works in this local two-browser test, and live peers merge edits after reconnection. Offline document reopening and draft recovery need fixes before they can be relied on. These checks do not establish behavior on separate physical devices, across the public internet, or for spreadsheets, slides, and whiteboards.

Machine-readable evidence: Diwan-offline-realtime-report.json
Reproduction: node .\Verify-Offline-Realtime.mjs
