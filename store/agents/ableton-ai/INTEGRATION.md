# Local MIDI/audio and a read-only Live snapshot

`render` produces a Standard MIDI File, PCM WAV, and explicit note events. The custom sixteen-step mask is stored with the controls. `live` imports the pinned upstream `AbletonConnection` and sends only `get_session_info`. Upstream bridge environment variables select the local host/port. The optional full MCP server is `upstream/src/ableton_ai/server.py`; see the upstream README to enable its Control Surface.

## Verification scope

The local loop works without Ableton. Live snapshots are tested at the transport contract with an isolated local responder; that does not claim a running Ableton application was tested. No existing Live tracks or transport are changed by this wrapper.

The browser acceptance suite lives in `store/viewers/studio-viewer/test/studios.e2e.mjs`.
`TESTING.md` beside that viewer records commands, outcomes, screenshots and coverage.
Upstream source revisions are in `upstream.lock.json`; install-time Python dependencies are
hash-locked in `requirements.lock`. No user application configuration is written by setup.
