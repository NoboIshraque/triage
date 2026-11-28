# ADR 0005: Show any Triage tab on a phone or tablet: a web app paired by QR code, with the laptop doing the work

- **Status:** **Accepted**, 2026-11-25, with the owner's choices (the end of this
  ADR). Proposed the same day at the owner's request.
- **Related:** [ADR 0001](0001-standalone-app-on-vscode-codebase.md) (the app is a
  VS Code fork), [ADR 0002](0002-absorb-engines-headless.md) (hidden engines),
  PLAN §4.16 and §4.15, ROADMAP phase **PC**, research
  [companion.md](../research/companion.md)

## In plain words

**Your phone becomes another screen for Triage.** Beside the Schematic, Board, 3D
and Sim tabs there is a **Show on phone** menu. Pick it and a QR code appears at
once. Point the phone's camera at it: Triage's phone app opens (the first time
in the browser, which offers to add it to the Home Screen). Both screens then
show the **same six-digit code**. If they match, click **Allow** on the laptop and
choose **View only** or **View and edit**. That's it: the phone shows the tab you
picked, and you can switch to the project's other tabs. Triage asks that question
every time you share, and while a phone views, the laptop can give it edit
permission (or take it back) at any moment.

On the phone you can pan and pinch-zoom the PCB, tap a part to see its value and
net, orbit the 3D model, and run the simulation and press its virtual buttons.
With edit permission you can also make the simple edits the laptop's tabs allow
(change a value, move or rotate a part, undo), and they show up on the laptop
straight away. Next time the phone app reconnects by itself while Triage is
running. No QR is needed; it starts as view only, and the laptop shows a
notification with **Allow editing**. You can remove the phone from the laptop's
list at any time.

**The laptop still does all the work.** KiCad's and FreeCAD's engines, the
simulation and your files stay on the laptop. The phone only receives what to
draw and sends back what you tapped, much as Triage's own tabs talk to the
hidden engines (ADR 0002). So the phone needs no installation of KiCad or
FreeCAD, and a cheap phone is enough. It also means **the laptop must be on and
running Triage**: the phone is a remote screen, not a copy of the project.

**Why a code on both screens?** The QR code alone would let anyone who can see
your screen connect, for example a classmate looking at the projector while you
present. The matching code and your **Allow** click mean only a phone you are
holding gets in, and only with the permission you chose.

**How the phone reaches the laptop:** on the same Wi-Fi, directly, encrypted, with
no internet needed once the app is installed. On different networks (the laptop
at home, the phone on mobile data), through a small relay server that passes
sealed messages it cannot read, like the one Signal uses to link its desktop app.
The keys that seal them exist only on the laptop and the phone (they meet through
the QR code), so whoever runs the relay sees only scrambled bytes. The direct
path is always tried first.

## Context

The owner (2026-11-25): Triage is Windows and Linux only, which is a problem on
small single-screen laptops. Students should be able to check the simulation,
the 3D model or the PCB on a handheld device, or continue the design session
there, from a web app they can install or add to the Home Screen on Android and
iOS, paired through a QR code (as WhatsApp links a computer) and one or two
verification steps.

Constraints from the plan:
- **One window, one project** (PLAN §1, D9): the phone is one more Triage view of
  the open project, never the stock KiCad or FreeCAD app, and never a second copy
  of the files.
- **Engines stay on the laptop** (ADR 0002). A phone cannot run them.
- **Windows first** (ADR 0003): the laptop side must build and run on Windows with
  a per-user install (no administrator).
- **Offline** (PLAN §1): working on the same Wi-Fi must not need the internet.
- **No data to Microsoft** (ROADMAP P8-7 item 6), **no cloud accounts** (PLAN §0).
- **Never run downloaded binaries** in Claude's sessions (CLAUDE.md): everything on
  the laptop side is built from source.

What the research found ([companion.md](../research/companion.md)):

| Product | How a second device joins | Lesson |
|---|---|---|
| WhatsApp | The new device shows a QR with its public key and a one-time secret that never reaches the server; the phone signs it into the device list. An 8-character typed code is the fallback. Linked devices expire after 35 days unless re-signed [D] | the device that holds the data authorizes; secret stays off the server; typed-code fallback; expiry |
| Signal Desktop | QR `sgnl://linkdevice?uuid=…&pub_key=…`; the server relays one encrypted envelope to a random 16-byte address; the QR rotates every 45 s, the socket closes after 90 s; the admitting code is single use [O] | a relay that only forwards sealed messages; rotating, expiring, single-use QR |
| VS Code tunnels | Microsoft's dev tunnels relay, GitHub or Microsoft account on both ends, Microsoft's app IDs, a closed signing module in official builds [O][D] | reuse ideas (device codes, connection tokens, keep-awake), not the service |
| KDE Connect | Same Wi-Fi, self-signed certificates, an 8-character code from both keys on both screens, then the certificate is pinned [O] | compare a short code, then pin |
| Sunshine / Moonlight | A 4-digit PIN typed on the host; paired client certificates are the only ones accepted; 5-minute pairing window [O] | a revocable list of paired devices |
| Onshape mobile | Native apps (in their day mobile WebGL was poor) talking to the cloud over WebSockets [D] | WebGL 2 now works in every phone browser [D], so a web app is enough for Triage |

Phone browsers in November 2026 [D]: WebGL 2 everywhere (Safari 15+); installable
web apps (iOS 26 opens every Home Screen site as a web app); **WebTransport with
`serverCertificateHashes`** (connect to a self-signed certificate pinned by its
hash) in Chrome 100+ and **Safari / iOS 26.4+**; X25519 in WebCrypto (Safari 17+,
Chrome 133+); no Web Bluetooth or `BarcodeDetector` on iOS; Home Screen web apps
on iOS keep **their own storage**, separate from Safari's.

## Options

### A. What runs on the phone

| Option | For | Against | Verdict |
|---|---|---|---|
| **A1** VS Code's own web client (`serve-web`, tunnels) | exists in the fork | a desktop IDE on a phone screen; gives the phone a remote extension host and terminal (far more reach than a viewer needs); the tunnel service is Microsoft's | **rejected** |
| **A2** Video of the laptop's tab (Moonlight's model) | any view works at once | blurry thin lines and text, a constant video stream, every pan goes to the laptop and back, renders each view twice | **rejected for now**; possible later fallback for a view with no phone renderer |
| **A3** Triage's own phone app drawing **scene data** (display lists, tessellations, simulation state) with Triage's renderers | crisp at any zoom, local pan and zoom, small updates; the WebGL2 board and schematic renderer already has no VS Code imports [O] | a touch UI to build; each view needs a phone renderer (3D, plots) | **recommended** |
| **A4** Native iOS and Android apps | full platform access (local network, Bluetooth, background) | two app stores, an Apple developer account, Swift and Kotlin code for a team of two | **later**, if needed: a thin wrapper around A3 |

### B. How the phone gets the app

| Option | For | Against | Verdict |
|---|---|---|---|
| **B1** The laptop serves it over plain `http://` on the LAN | nothing to host | not a secure context: no service worker, no `crypto.subtle`, no install on Android; anyone on the Wi-Fi can alter the code in transit | **rejected** |
| **B2** The laptop serves it over HTTPS with a self-signed certificate | nothing to host | a full-page certificate warning on every phone; no service worker on an invalid certificate; teaches students to click through warnings | **rejected** |
| **B3** A static web app (PWA) at a **public HTTPS origin** Triage controls | installable on both systems, works offline once installed, WebCrypto and service worker available; the host sees no secrets (they travel in the URL fragment) | someone must host it; whoever controls that origin controls the phone's code (mitigations in PLAN §4.16) | **recommended** |
| **B4** App stores | store trust and updates | as A4 | later |

### C. How the phone reaches the laptop

| Option | For | Against | Verdict |
|---|---|---|---|
| **C1** **WebTransport** (HTTP/3) from the phone app straight to the laptop's LAN address; the laptop's self-signed certificate is pinned by the hash in the QR | direct, encrypted, no warning page, no certificate authority, **no internet needed**; the laptop side is a small Rust server built from source | needs iOS 26.4+ (Android Chrome 100+); the laptop renews its certificate every 2 weeks (browser rule) and gives paired phones the next hashes in advance; Windows firewall behavior for a per-user app unknown [?] | **recommended** for the same network |
| **C2** WebRTC data channel (peer to peer, NAT traversal, TURN) | works on older iOS; crosses many NATs | needs a signalling server anyway, plus TURN for strict networks; a heavier native stack on the laptop | **fallback**, if the PC-1 spike finds C1 blocked |
| **C3** A small **relay** (WebSocket over HTTPS) that forwards end-to-end-encrypted frames between the phone app and the laptop | works across networks, on Wi-Fi that isolates devices and on older iOS (17+); never holds keys (Signal's pattern) | someone hosts and pays for it; it sees IP addresses, timing and sizes; slower than C1 | **recommended** as the second path, **optional** (off until the owner sets up a relay) |
| **C4** VS Code tunnels / Microsoft dev tunnels | a working relay | Microsoft's service, accounts and app IDs; against P8-7 item 6 | **rejected** |
| **C5** Public certificates for LAN addresses (Plex's `plex.direct` model) | standard HTTPS on the LAN | Triage would run DNS and a certificate service for every user; routers with DNS-rebinding protection break it [D] | **rejected** |

### D. Pairing and trust

| Option | Verdict |
|---|---|
| **D1** QR with a one-time secret and the laptop's public key; a code on both screens; **Allow** on the laptop with a permission; per-phone keys the laptop can revoke | **recommended** |
| **D2** Sign in with the same account (GitHub) on both | rejected: PLAN §0 keeps cloud accounts out; GitHub's sign-in is already a struggle (P0-8) |
| **D3** Typed 8-character code (WhatsApp's option 2, Magic Wormhole's model) when the camera fails | **recommended as the fallback**; needs the relay to meet |
| **D4** Bluetooth or NFC tap | not available to web apps on iOS [D] |

## Decision

1. **A phone and tablet companion** joins the plan as PLAN §4.16 and ROADMAP phase
   **PC**, after M2 and **before P4** (the owner's choice), so schematic, board,
   3D and simulation all exist to show.
2. **The phone runs a Triage web app** (A3 + B3): TypeScript in `companion/web/`,
   hosted as static files at a public HTTPS origin, installable on Android and
   addable to the Home Screen on iOS. It bundles Triage's renderers (the WebGL2
   display-list renderer now; the 3D view and plots later) and draws data the
   laptop streams. It never runs the engines and never holds the files.
3. **Transport:** WebTransport on the same network (C1), and a **relay** for
   everything else (C3; the owner chose to have one). Both carry the same **companion protocol** inside an
   end-to-end **Noise** session between the phone and the laptop (X25519,
   AES-GCM, SHA-256, all in WebCrypto). On the LAN this sits inside TLS pinned
   to the laptop's certificate. The PC-1 spike confirms C1 on real phones;
   WebRTC (C2) is the fallback if it fails.
4. **Pairing:** D1, with D3 as the fallback. The phone's key is a non-extractable
   WebCrypto key in the installed app's storage. The laptop keeps its keys in
   VS Code's secret storage (Electron `safeStorage`: DPAPI on Windows).
5. **Permissions per session:** the laptop asks **View only** or **View and edit**
   every time it shares (pairing, or **Show on** a paired phone). A phone that
   reconnects by itself starts as view only, with **Allow editing** in the
   laptop's notification. During any session the laptop can switch the phone
   between the two at once, from the status bar item or the Phones list; the
   phone shows a banner when it changes. Edits are the engines' own edit commands (`triage.eda.v1` `Edit`, later CAD and simulation
   controls), checked by the laptop. The phone never gets files, a terminal,
   tasks, extensions or settings.
6. **Laptop side:** a **companion broker** utility process (the P0-4 pattern)
   hosting `crates/triage-companion` (Rust, napi-rs: WebTransport server,
   certificates, Noise, pairing records, relay client). The window's engine
   services serve the phone's requests, so phone edits land in the same engine
   document and undo history as the laptop's.
7. **Off by default.** Nothing listens until the user picks **Show on phone**. After
   pairing, the laptop listens on the LAN (and connects to the relay, if one is
   set up) only while Triage runs with the companion setting on.

## Consequences

Good:
- Small-screen and single-screen users get a second screen they already own. A
  teacher can walk around and look at a student's board on a tablet.
- The renderers and the engine protocol are reused, not rewritten. The phone gets
  exactly what the laptop's tabs get, so the views match.
- It works on the same Wi-Fi with no internet and no server.
- Pairing follows proven designs (WhatsApp, Signal, KDE Connect).

Costs:
- **A new attack surface:** a listening port on the laptop and edits from another
  device. PLAN §4.15 gains rules; PC-2 and PC-7 include security reviews and
  fuzz tests.
- **Hosting:** a public origin for the phone app (static, free on GitHub Pages)
  and a relay (a small always-on service, with traffic costs). Whoever
  controls the origin controls the phone app's code.
- **iOS 26.4+** for the direct path. Older iPhones (iOS 17+) work only through the
  relay.
- **Touch UIs** for each view, and the 3D view (P2-3) and the instruments (P3-5)
  must keep their drawing code free of VS Code imports, as P1-4 did, so the phone
  app can bundle it.
- **The laptop must stay on.** Triage can keep it awake while a phone is connected,
  as `code tunnel` does (optional setting).
- One more phase (about 6 weeks, before P4, which moves back by as much) and one
  more Rust crate.
- PLAN §0 listed "mobile" as out of scope for v1.0. That line now excludes native
  mobile apps only (DEVIATIONS).

## The owner's decisions (2026-11-25)

1. **Accepted**, with a walkthrough of how it works (this ADR's plain words and
   PLAN §4.16).
2. **Where the phone app lives:** **GitHub Pages** for now, **the owner's own domain**
   later. The repository is public since 2026-11-25 (DV-24), so Pages needs no
   paid plan. Moving to the domain makes paired phones pair
   once more (their keys belong to the app's origin).
3. **Relay: yes**, "whichever is the most secure". So: the relay only ever forwards
   frames sealed end to end with the Noise keys that phone and laptop agreed
   through the QR; it holds no keys, no accounts and no content logs; mailboxes
   are random 16-byte ids; frames are size-, rate- and idle-limited; the direct
   LAN path is always tried first. Where the relay runs (a serverless WebSocket
   service or a small server) and what it costs is put to the owner in PC-1,
   before any account is created.
4. **iOS / iPadOS 26.4 or newer** for the direct path: accepted (older iPhones,
   iOS 17+, through the relay).
5. **When:** **between P3 and P4**. P4 onward move by about 6 weeks.
6. **Permission:** asked **each time** the laptop shares; a view-only phone can be
   given edit permission from the laptop during the session (decision 5 above).

## PC-1 results and the relay's host (2026-11-28)

**WebTransport works as planned (C1), in a real browser engine.** The built phone
app, in Chromium with a Pixel 7's and an iPhone 15's emulation
(`companion/web/scripts/spike.mjs`), and in an Electron window in CI's smoke test,
connected to the laptop's Rust server (`crates/triage-companion`, `wtransport`
0.7) over WebTransport with the laptop's self-signed ECDSA P-256 certificate
pinned by its hash from the QR link: no warning page, no certificate authority.
Noise `IKpsk2` in WebCrypto agreed with `snow` byte for byte (the same six digits
on both screens), the board's display list was drawn by `edaRenderer.ts`, and a
value edit from the tapped part reached the laptop. WebRTC (C2) is not needed.

| Measure (Pixel 7 emulation, Chromium, this container's software graphics) | Result |
|---|---|
| Opening the QR link to the board drawn (incl. the 0.2 s the scripted laptop waits before Allow) | 2.2–3.0 s (PLAN target: 3 s) |
| A board display list of 816 KB (40,000 segments, 400 pads): request to drawn | 58–97 ms (8–14 MB/s through Noise and WebTransport) |
| A sealed request and its reply over WebTransport | 0.5–0.6 ms (loopback) |
| Frame rate | 2 fps: each draw call takes 0.1 ms; the time is compositing a 1082 × 1811 canvas without a GPU. Real phones are owner check C8 |

**Found:** Chromium rejects the content-security-policy keyword
`'unsafe-webtransport-hashes'` as invalid and connects with `connect-src https:`;
the app's policy doesn't use it (DV-52). Still to see on real phones (C8): Safari
26.4's WebTransport, its local-network prompt, the camera inside the installed
app, and what Windows Defender Firewall asks when Triage first listens.

**The relay runs on Cloudflare Workers** (the owner's choice, 2026-11-28, from
Cloudflare's free plan with Durable Objects, Fly.io at about $2.19 a month, or a
small VPS at about €4–6.50 a month): one Durable Object per mailbox, WebSocket
hibernation so a waiting laptop costs nothing, the same limits as the Node relay
(`companion/relay/cloudflare/`). The owner creates the account and adds its API
token as a repository secret; the Companion workflow deploys it (check C8). The
typed code uses `NNpsk0` with the code stretched by PBKDF2 (WhatsApp's option 2),
not SPAKE2 (DV-51).
