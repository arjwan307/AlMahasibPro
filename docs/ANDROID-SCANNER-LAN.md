# Android scanner LAN compatibility (1.0.6)

The existing native scanner is maintained in `android-scanner` in this repository. Its previous QR parser accepted HTTPS only and the Android manifest disabled cleartext traffic. Desktop Offline advertises a private IPv4 HTTP origin, so the installed old app cannot connect to that QR.

Changes: allow HTTP pairing only for literal RFC1918 IPv4 addresses; retain HTTPS and retail paths; disable redirects; use bounded network timeouts; resolve six-digit codes at the selected server; send request_id and retain it on failed scans; heartbeat the existing status API. Network errors refer to Wi-Fi/LAN and Windows Firewall.

Use the desktop QR for the first connection: it supplies both the local address and token. A short code can be entered after the app already knows that cashier server from a successful QR connection. Six digits alone do not discover a server on an unknown network. Native automatic LAN discovery is not implemented.

Pending scan identity is retained while the app process runs, not across process termination. Existing license requirements remain on the desktop server.

Verification: 26 pure Java pairing URL cases executed locally on Java 17. Full Android compilation/lint is delegated to the existing scanner build workflow on `development/android-scanner-lan`. No real Android/Windows test has been performed. Camera and printer hardware behavior is unverified. This is a debug test APK, not a commercial release.
