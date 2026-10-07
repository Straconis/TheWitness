# 0.1.13 — review sweep fixes

Malformed WebSocket upgrade URLs are rejected before authentication instead of escaping the handler and crashing the bot. Saved session metadata is validated before listing, recovery, export or deletion; damaged records are skipped in listings and preserved on disk.

Rejected final intro uploads now remove their temporary chunks even when format recognition or assembly fails. Existing intros remain intact. Audio tool cancellation/error cleanup waits for the child close event across exports, loudness/silence analysis and editor waveforms, preventing file cleanup from racing a still-closing process.

Operator setup/redaction refresh now recognizes quoted multiline dotenv secrets, exported assignments, escaped newlines and unquoted comments. Individual multiline secret lines are included for redaction when journal messages split them. The portal login remains unchanged on refresh; run the refresh command after secret rotation. Redaction remains best-effort rather than a guarantee against arbitrary secret representations.

The simple excerpt form is now restricted to exports without timeline edits, intros or silence cuts. Those transformations made its original-recording offsets incorrect. Processed exports direct users to the existing multitrack editor; direct API requests are also rejected rather than generating the wrong audio segment.

The source/deployment review also checked recording/reconnect/shutdown, queue persistence/concurrency, schedules/retention, signed links, cloud credentials/uploads, archive generation, and portal source restrictions. After code deployment, the operator applied the separate Cloudflare visitor-IP nginx configuration fix; it trusts only validated Cloudflare ranges. Real-session recording, Discord delivery and OBS drift still require live validation.
