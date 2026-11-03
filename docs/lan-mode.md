# LAN mode (stub)

> Status: Phase 0 stub. The env handling exists; a tested reverse-proxy walkthrough is Phase 5 work.

By default SiteSync listens on `127.0.0.1:3000` only and is reachable from this machine alone. **That is the recommended setup.**

LAN mode lets other devices on your network reach SiteSync. It is only safe over HTTPS, so SiteSync never terminates TLS or binds to the network itself. Instead:

1. Keep SiteSync bound to `127.0.0.1` (the `dev`/`start` scripts always do this).
2. Run a reverse proxy you control (for example Caddy or nginx) on the same machine. It terminates HTTPS with a certificate your devices trust and forwards to `http://127.0.0.1:3000`, passing `Host`/`X-Forwarded-Host` through.
3. In `.env`, set **both**:
   ```
   SITESYNC_LAN_MODE=true
   SITESYNC_PUBLIC_ORIGIN=https://sitesync.your-lan-name
   ```
   SiteSync refuses to start if `SITESYNC_LAN_MODE=true` without an `https://` public origin.

What changes in LAN mode: the origin that mutating Route Handlers (such as sign-out) accept becomes `SITESYNC_PUBLIC_ORIGIN` instead of `SITESYNC_APP_ORIGIN`. Server Actions keep Next.js's own Origin-vs-Host check, which works through a proxy that forwards the host header.

Not covered yet: proxy configuration examples, certificate guidance, and an end-to-end test through a proxy.
