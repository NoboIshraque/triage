# Research: phone and tablet companion (QR linking, viewing and editing from a phone)

**Question (the owner, 2026-11-25):** students with one small laptop screen should
be able to pick **Show on phone** beside a Triage tab, scan a QR code (as when
WhatsApp links a computer), pass one or two checks, and then view, and if needed
edit, that tab on an Android or iOS phone, from a web app they can install or add
to the Home Screen. How do existing products link a second device, and how does
that fit Triage? The plan built from this research is
[ADR 0005](../adr/0005-phone-companion.md) and PLAN §4.16.

**Method:** read the source of the open-source apps (shallow clones, data only),
REA static analysis of one shipped app (Signal Desktop 8.36.0 for Linux), vendor
documentation for closed apps and for the phone browsers, and the Triage code
that a phone client could reuse. Nothing downloaded was executed (CLAUDE.md).

Legend: **[O]** observed in source or shipped files · **[I]** inferred ·
**[D]** documentation · **[?]** unknown.

| Target | Version read | How |
|---|---|---|
| WhatsApp multi-device | "WhatsApp Encryption Overview", **version 10, 2026-10-30** (PDF SHA-256 `d4f7e87d…13546`) | whitepaper [D] |
| Signal Desktop | source `signalapp/Signal-Desktop` @ `01e59719` (2026-11-19); shipped **8.36.0** `.deb` (SHA-256 `45381fe0…a14`, matches Signal's apt index) | source [O]; REA + byte reads of the shipped bundle [O] |
| Signal Server | `signalapp/Signal-Server` @ `398888f2` (2026-11-20) | source [O] |
| libsignal | `signalapp/libsignal` @ `68ba4f58` (2026-11-24) | source [O]; REA exports of the shipped addon [O] |
| VS Code remote tunnels, `serve-web`, web server | Triage's fork, VS Code **1.147.0** (`app/upstream/`, commit `8a14f0cc`); `microsoft/dev-tunnels` @ `e61bd0c2` (2026-11-20); VS Code docs | source [O]; docs [D] |
| KDE Connect | `KDE/kdeconnect-kde` @ `27568643` (2026-11-25) | source [O] |
| Sunshine (the host for Moonlight game streaming) | `LizardByte/Sunshine` @ `433c8760` (2026-11-23) | source [O] |
| Onshape mobile, Plex, Magic Wormhole | vendor and project documentation | [D] |
| Phone browsers (Safari on iOS, Chrome on Android) | WebKit, Chrome, MDN and caniuse pages, read 2026-11-25 | [D] |

## 1. How the others link a second device

### 1.1 WhatsApp: the phone vouches for the new device

| Fact | Basis |
|---|---|
| One **primary device** (a phone) per account links the **companion devices**; Meta's 2021 post on multi-device said up to four | [D] whitepaper "Terms"; Meta engineering blog, 2021-07-14 |
| **QR option:** the companion shows its public **Identity Key** and a fresh 32-byte **Linking Secret Key** in the QR. The secret "is never sent to WhatsApp server" | [D] whitepaper, "Option 1: Link Using a QR-Code", steps 1–2 |
| The phone signs the companion's key (**Account Signature**), signs a new **device list**, and sends both plus an HMAC keyed with the linking secret through the server. The companion checks the HMAC and the signature, then signs the phone's key back (**Device Signature**). Only then do end-to-end sessions start | [D] steps 3–15 |
| **Code option:** the companion shows a random **8-character Base32 code** (40 bits). Both sides stretch it with PBKDF2-HMAC-SHA-256 (2^17 iterations) into a key that wraps an ephemeral X25519 exchange, so the short code yields a strong shared key. A wrong code fails the key agreement, and the phone cancels | [D] "Option 2: Link Using an 8-character Code", steps 1–25 |
| **Removal and expiry:** the phone uploads a new signed device list when a companion is removed, and re-signs the list periodically; signed device lists expire after **35 days or less**, so a companion whose phone stopped vouching is dropped | [D] "Companion Device Removal", "Signed Device List Expiry" |
| Client–server traffic runs inside **Noise Pipes** (Curve25519, AES-GCM, SHA-256); the server stores only public keys | [D] "Transport Security" |

**Lesson for Triage:** the device that holds the data (WhatsApp's phone, Triage's
laptop) is the one that authorizes the new device; the QR carries a **public key
plus a one-time secret** that never reaches a server; a short **typed code** is
the fallback when scanning fails; linked devices **expire** unless renewed. In
Triage the roles are reversed (the laptop shows the QR, the phone scans it),
because the phone's camera app is the easiest way to open a web page [I].

### 1.2 Signal Desktop: a QR URL, an empty mailbox and an encrypted envelope

| Fact | Basis |
|---|---|
| The desktop opens a WebSocket to the server's **provisioning** endpoint (`/v1/websocket/provisioning/`). The server answers with a random **provisioning address**: 16 random bytes, Base64url | [O] `ProvisioningConnectListener.java` (`generateProvisioningAddress`); path in `WhisperServerService.java` |
| The QR holds `sgnl://linkdevice?uuid=<address>&pub_key=<desktop public key>&capabilities=…` | [O] `ts/util/signalRoutes.std.ts` (`linkDeviceRoute.toAppUrl`); the same template in shipped 8.36.0's `bundles/chunks/notifications.std-*.js` |
| The phone encrypts a **ProvisionMessage** (account keys, profile key, a one-time **provisioning code**) to the desktop's public key: ECDH, then HKDF with the label `TextSecure Provisioning Message` into an AES-256-CBC key and an HMAC-SHA-256 key; version byte + IV + ciphertext + MAC | [O] `ts/textsecure/ProvisioningCipher.node.ts`; the label in shipped `bundles/preload/main.js` |
| The phone sends that envelope with `PUT /v1/provisioning/{address}`; the server only relays it (256 KiB maximum, rate limited, 404 if nobody is listening) to the open socket, then closes it. The server never sees the plaintext | [O] `ProvisioningController.java`, `ProvisioningManager.java` (Redis pub/sub) |
| The provisioning socket closes after **90 s**; the desktop rotates the QR every **45 s**, keeps at most **2** sockets open, and stops after **6** rotations (a `MaxRotationsError` the UI reports); successive connect attempts may take 10, 20, 30 and 60 s | [O] `Duration.ofSeconds(90)` in `WhisperServerService.java`; `ROTATION_INTERVAL`, `MAX_OPEN_SOCKETS`, `MAX_ROTATIONS`, `QR_CODE_TIMEOUTS` in `ts/textsecure/Provisioner.preload.ts`; the same constants (`45*…`, `2`, `6`, `[10*…, 20*…`) in shipped `bundles/preload/main.js` |
| The desktop then registers itself with the one-time provisioning code (`/v1/devices/link`); a used code is refused (`LinkDeviceTokenAlreadyUsedException`), and the phone can wait for "linked" (`/v1/devices/wait_for_linked_device/{token}`) | [O] `DeviceController.java` |
| In 8.36.0 the provisioning socket is opened by **libsignal's Rust networking code**, not by JavaScript: the shipped addon exports `ProvisioningChatConnection_connect` and holds the `/v1/websocket/provisioning/` path; the provisioning cipher is moving there too (`RecvProvisionCiphertextState_*`, `Provisioning_EncryptProvisionMessage`) | [O] REA exports of `@signalapp+libsignal-client.node` (852 exports); strings |
| Signal's shipped Electron build disables RunAsNode, NODE_OPTIONS and the inspector, and only loads the app from its asar | [O] REA `inspect-electron-fuses` |
| libsignal's **device-transfer** module makes a **self-signed certificate** for phone-to-phone transfer over the local network | [O] `rust/device-transfer/src/lib.rs` (`create_self_signed_cert`); how the apps pin it [?] |

**Lesson for Triage:** a **relay that only forwards one sealed message to a random,
short-lived address** is enough for pairing across networks, and it never needs
to be trusted with keys. QR codes should **rotate and expire** (45 s and 90 s
work for Signal), and the secret that admits a device should be **single use**.

### 1.3 VS Code remote tunnels and the browser client: what Triage could reuse

| Fact | Basis |
|---|---|
| `code tunnel` relays through **Microsoft dev tunnels** (`global.rel.tunnels.api.visualstudio.com`, Azure). Hosting and connecting both require signing in with **the same GitHub or Microsoft account**; vscode.dev is the client; an SSH session over the tunnel gives end-to-end encryption (AES-256-CTR); 10 tunnels per account | [D] VS Code docs "Remote Tunnels"; [O] `PROD_DNS_NAME` in dev-tunnels `rs/src/contracts/tunnel_service_properties.rs` |
| The CLI signs in with **device-code flows** using Microsoft's own app IDs (GitHub client `01ab8ac9400c4e429b23`, Microsoft client `aebc6443-…`, dev tunnels first-party app `46da2f7e-…`) | [O] `app/upstream/cli/src/auth.rs`; dev-tunnels `PROD_FIRST_PARTY_APP_ID` |
| Official builds sign tunnel challenges with **`vsda`**, a closed module; open-source builds use a plain SHA-256 of the challenge | [O] `cli/src/tunnels/challenge.rs` (`#[cfg(feature = "vsda")]`) |
| The CLI keeps the computer **awake** while a tunnel runs (`PowerCreateRequest` on Windows) | [O] `cli/src/tunnels/nosleep_windows.rs` |
| VS Code's own web server (`code serve-web`, the remote server) admits a browser with a **connection token**: `?tkn=` once, then a `vscode-tkn` cookie (SameSite, one week); it also serves a **web app manifest** (`resources/server/manifest.json`, `display: standalone`) | [O] `src/vs/server/node/serverConnectionToken.ts`, `webClientServer.ts`, `src/vs/base/common/network.ts`; `cli/src/commands/serve_web.rs` |
| Triage's `product.json` already sets `serverApplicationName: triage-server` and `tunnelApplicationName: triage-tunnel` | [O] `app/product.json` |

**What Triage can reuse:** the **device-code idea** (a short code instead of a
password), the **connection-token pattern** (a one-time token in the URL, then
something stored), the **keep-awake** behavior, and the web app manifest
pattern. **What it should not reuse:** the tunnel service itself (Microsoft's
relay, Microsoft's app IDs and accounts, a closed signing module; P8-7 item 6
says no data to Microsoft), and the full VS Code web client (a desktop IDE in a
phone browser, with a remote extension host and terminal: far too much reach for
a phone) [I].

### 1.4 KDE Connect: same Wi-Fi, self-signed certificates, a code on both screens

| Fact | Basis |
|---|---|
| Devices find each other by **UDP broadcast** on port 1716 (and mDNS), then connect over **TCP 1716–1764** | [O] `core/backends/lan/lanlinkprovider.h`, `.cpp` |
| Each device has a **self-signed EC P-256 certificate**. Before pairing the TLS peer is only queried (`QueryPeer`, self-signed accepted); after pairing the stored certificate is the only one trusted (`VerifyPeer`) | [O] `core/sslhelper.cpp`; `configureSslSocket()` in `lanlinkprovider.cpp` |
| Pairing shows a **verification key** on both screens: the first 8 hex digits of SHA-256(both public keys, sorted, + the pairing timestamp). Requests time out after **30 s**; a timestamp more than 30 min off is refused | [O] `PairingHandler::verificationKey()`, `pairingTimeoutMsec`, `ALLOWED_TIMESTAMP_TIME_DIFFERENCE_SECONDS` in `core/backends/pairinghandler.*` |

**Lesson:** trust-on-first-use certificates are safe when the user **compares a
short code derived from both keys**; after pairing, pin the certificate. KDE
Connect is a native app because a browser can do none of UDP discovery, raw
TCP or accepting an unknown certificate [I].

### 1.5 Sunshine and Moonlight: a PIN typed on the host

| Fact | Basis |
|---|---|
| The client (Moonlight) shows a **4-digit PIN**; the user types it on the host (Sunshine's web UI). Both derive an AES key from SHA-256(salt + PIN), run a challenge-response, exchange certificates and sign the pairing secret | [O] `src/nvhttp.cpp` (`getservercert`, `clientchallenge`, `serverchallengeresp`, `clientpairingsecret`, `is_valid_pairing_pin`), `src/crypto.cpp` (`gen_aes_key`) |
| Pairing sessions expire after **5 minutes**; paired client certificates form the only chain the host's HTTPS server accepts | [O] `PAIRING_SESSION_TIMEOUT` in `src/nvhttp.h`; `cert_chain` in `nvhttp.cpp` |

**Lesson:** "type what you see on the other screen" works as the second check, and
the host keeps a **list of paired client certificates** it can revoke one by one.
Streaming video (Moonlight's model) is the alternative to sending scene data; §3
weighs it.

### 1.6 Others

| Product | What matters for Triage | Basis |
|---|---|---|
| **Onshape** mobile | Native iOS and Android apps sharing one C++ graphics library, WebSocket messaging to the cloud. They chose native over a hybrid app because of "the poor WebGL support on mobile browsers" at the time. They view, review and comment on phones and say full functionality is limited there | [D] Onshape blog "Under the hood: CAD for mobile", "CAD mobile use cases" |
| **Plex** | Gets valid HTTPS to a LAN address by giving each server a wildcard certificate for `*.<hash>.plex.direct` and running DNS that maps `192-168-1-10.<hash>.plex.direct` to `192.168.1.10`. Routers with DNS-rebinding protection break it | [D] Plex support "secure server connections"; F. Valsorda, "How Plex is doing HTTPS for all its users"; Plex forums |
| **Magic Wormhole** | Short human codes, **SPAKE2** to turn them into a strong key, a WebSocket **mailbox** server for the first messages and a **transit relay** when no direct connection works; an attacker gets one guess per code | [D] magic-wormhole documentation |
| **Wokwi** | Runs the MCU emulators client-side in the browser (also on phones) | [O] [simulators.md](simulators.md) §6 |

## 2. What a phone browser can do (November 2026)

| Capability | Android (Chrome) | iPhone and iPad (Safari, Home Screen web apps) | Basis |
|---|---|---|---|
| **WebGL 2** | yes | yes since **Safari 15** (on Metal) | [D] WebKit "New WebKit Features in Safari 15" |
| Install | install prompt for a site with a manifest over HTTPS | **Add to Home Screen**; since iOS 26 every site added opens as a web app by default | [D] Chrome's installability criteria (web.dev); WebKit "News from WWDC25" |
| **WebTransport** with **`serverCertificateHashes`** (connect to a server with a self-signed certificate pinned by its SHA-256) | Chrome **100+** | Safari / iOS **26.4+** | [D] caniuse (MDN data); WebKit bug 300057 fixed 2025-10-02 |
| Rules for that certificate | X.509v3, ECDSA P-256 (no RSA), validity **under 2 weeks**, HTTPS URL with explicit port, `allowPooling` false; a page with a `connect-src` policy must allow it with `'unsafe-webtransport-hashes'` | same | [D] MDN `WebTransport()`; the CSP keyword from a web-platform test (Mozilla bug 2016081), to check in PC-1 |
| X25519 / Ed25519 in WebCrypto | Chrome 133+ | Safari / iOS 17+ | [D] caniuse |
| Camera (`getUserMedia`) in an installed web app | yes | fixed for standalone web apps in 2020; later reports of failures on some devices | [D] WebKit bugs 185448, 273938, 282327 |
| `BarcodeDetector` (native QR decoding) | yes | **no** (off by default) | [D] caniuse |
| Web Bluetooth, WebUSB, Web Serial | yes | **no** | [D] caniuse |
| Storage | per origin | **Home Screen web apps don't share storage with Safari**; Safari's 7-day cap on script-written storage doesn't apply to Home Screen web apps (their counter follows their own use) | [D] WebKit bug 181849; WebKit blog clarification (2020), storage policy (Safari 17) |
| Reaching the LAN from a public HTTPS page | Chrome 142+ asks a **Local Network Access** permission for fetches; WebSockets, WebTransport and WebRTC "not yet gated", planned | iOS has a local-network permission for apps; for Safari itself [?] | [D] Chrome blog "Local Network Access" |
| `http://` page on the LAN | not a secure context: no service worker, no `crypto.subtle`, Chrome offers no install | same, though Add to Home Screen still adds it | [D] MDN secure contexts |
| URL fragment (`#…`) | never sent to the server | same | [D] RFC 3986 §3.5 |

**What this means [I]:**
- A phone web app can draw Triage's boards and 3D models (WebGL 2 everywhere).
- It must come from a **public HTTPS origin** to be installable and to use
  WebCrypto and a service worker. A page served by the laptop over plain HTTP,
  or over HTTPS with a self-signed certificate, gets none of that, or a warning
  page.
- From that origin it can still reach the laptop **directly on the LAN, with no
  warning and no certificate authority**, through WebTransport with the laptop's
  certificate hash taken from the QR. That needs iOS 26.4 or newer.
- Across networks, or on Wi-Fi that isolates devices, it needs a relay.
- On iOS, pairing must happen **inside the installed web app** (its storage is
  separate from Safari's), so the app needs its own scanner (a JavaScript QR
  decoder; iOS has no `BarcodeDetector`) and a typed-code fallback.
- The secret can ride in the URL fragment, which the hosting server never sees.

## 3. Pixels or scene data?

| | Stream the rendered tab as video (Moonlight, Steam Link) | Stream Triage's scene data (display lists, tessellations, sim state) |
|---|---|---|
| Phone work | decode video | draw with WebGL 2 (Triage's own renderers) |
| Laptop work | render the tab a second time at phone size and encode it | none extra: the engines already produce these data for the laptop's tabs |
| Text and thin lines | blurry at phone resolution, re-encoded on every pan | crisp at any zoom; pan and zoom are local, no round trip |
| Touch editing | every tap goes to the laptop and back | selection and hit tests through the engine as on the laptop; pan, zoom and orbit stay local |
| Offline snapshot | no | yes (keep the last lists) |
| Bandwidth | megabits per second all the time | a burst when a view opens, then small updates |

**Choice [I]:** scene data. The laptop's engines already stream display lists and
(from P2) tessellations to Triage's renderers, and those renderers are plain
WebGL code (§4). Video stays a possible later fallback for a view with no phone
renderer.

## 4. What Triage already has that a phone client can reuse

| Piece | What it is | Reuse on the phone | Basis |
|---|---|---|---|
| `app/src/vs/triage/browser/eda/edaRenderer.ts` (523 lines) | WebGL2 renderer for Stream GAL display lists: per-layer buffers, instanced capsules, circles and arcs with exact edges, KiCad's level of detail | **as is**: its only import is the display-list model ("No VS Code imports … tested headless") | [O] file header and imports |
| `common/eda/displayList.ts` (224), `protobuf.ts` (340), `engineApi.generated.ts` (314), `common/engineProtocol.ts` (158) | display-list reader (`TDL1` chunks), proto3 codec, the `triage.eda.v1` message descriptors, the length-prefixed frame codec | **as is**: no VS Code imports | [O] imports |
| `engines/eda/triage/api/proto/triage/eda/v1/engine.proto` | open, display list, hit test, selection, highlight, items, netlist, edits (move, rotate, delete, set field, place, wire, track, rename net), undo, redo, save | the phone sends the **same requests**; the laptop filters them by permission | [O] |
| `engines/eda/triage/stream_gal/display_list.h` | version-1 binary format, 4-byte little-endian fields, 4 MiB chunks, first/last flags, group updates and deletes | the same chunks travel to the phone; 4 MiB chunks are split for the wire | [O] |
| `electron-browser/edaEngineService.ts` | one service per window that owns the engine documents and fires `onDidChangeDocument` after edits | the phone's requests go **through this service**, so phone edits land in the same engine document and undo history as the laptop's | [O] |
| `node/edaEngineBrokerMain.ts`, `node/engineSupervisor.ts` | utility-process broker, restart with backoff | the pattern for a **companion broker** utility process | [O] |
| `browser/eda/edaDocumentView.ts` | pointer events with capture (mouse) | the phone needs its own touch layer (pinch, two-finger pan, long press); it imports VS Code services, so it is not reused | [O] imports |
| VS Code's secret storage (`encryptionMainService.ts`) | Electron `safeStorage` | keep the laptop's companion keys there | [O] |
| PLAN §4.11 | "wasm-bindgen for a future web build" of the Rust kernel | a later option: run a code-only simulation on the phone, as Wokwi does | [D] plan |

**Constraint for later WPs [I]:** the 3D view (P2-3) and the plots and instruments
(P3-5) should keep their drawing code free of VS Code imports, as P1-4 did, so the
phone app can bundle it.

## 5. REA runs and their limits

| Run | Result | Basis |
|---|---|---|
| `extract-artifact` on `app.asar` (41 MB) | 1,752 nodes; the main bundles are `bundles/main.js` and `bundles/preload/main.js` (6.9 MB) | [O] ledger, round 4 |
| `inspect-electron-fuses` on `signal-desktop` | RunAsNode, NODE_OPTIONS and inspector **off**; OnlyLoadAppFromAsar **on**; cookie encryption on | [O] |
| `inspect-desktop-application` | 135 files, one Electron candidate | [O] |
| `analyze-javascript-application`, `bundles/main.js` + `bundles/preload/main.js` (worker 2 GiB) | `main.js` parsed (187,269 syntax nodes, 368 findings); its semantic graph exceeded the parent's result budget. **`preload/main.js` exhausted the 2 GiB worker heap**, and again at **3 GiB** in a run of its own. This session kept REA under 4 GB (another heavy build shared the machine), so the provisioning facts above were confirmed by reading the shipped bytes instead | [O] ledger, round 4 |
| `inspect-native-exports` on `@signalapp+libsignal-client.node` (23 MB) | 852 exports, complete, including the provisioning functions in §1.2 | [O] |

## 6. Unknowns and limits

- [?] WhatsApp's own apps were not analyzed: WhatsApp Desktop ships for Windows
  and macOS only (Microsoft Store, App Store), and WhatsApp Web is a live,
  obfuscated site. The whitepaper is the evidence.
- [?] Signal's preload bundle as a REA graph (needs more than a 3 GiB worker heap).
- [?] Whether Safari on iOS shows a local-network permission prompt before a
  WebTransport connection to a LAN address, and whether Chrome's Local Network
  Access prompt will cover WebTransport (announced as planned).
- [?] Whether Windows Defender Firewall lets a per-user app listen for UDP (QUIC)
  on a private network without an administrator, and what it asks the user.
- [?] Whether client-isolated school or campus Wi-Fi lets the phone reach the
  laptop at all (if not, only the relay works).
- [?] Throughput and frame rates on a real phone: none measured (no device in a
  cloud session). The PC-1 spike measures them on the owner's phone.
- [?] How Onshape and Fusion split computation between cloud and phone (their
  posts don't say).
- Runtime behavior of every app here is unknown: static reading only.

## 7. Reproduce

```bash
W=/abs/workdir; mkdir -p $W/src && cd $W/src
for r in signalapp/Signal-Desktop signalapp/Signal-Server signalapp/libsignal \
         KDE/kdeconnect-kde LizardByte/Sunshine microsoft/dev-tunnels; do
  git clone --depth 1 --filter=blob:none --sparse https://github.com/$r.git
done   # then `git sparse-checkout set` the paths cited above
# Signal Desktop 8.36.0: pool/s/signal-desktop/signal-desktop_8.36.0_amd64.deb from
# https://updates.signal.org/desktop/apt (check the SHA-256 against its Packages index)
dpkg-deb -x signal-desktop_8.36.0_amd64.deb $W/x/signal-8.36.0
REA=../rea/scripts/rea-unbounded.sh
$REA extract-artifact $W/x/signal-8.36.0/opt/Signal/resources/app.asar --format json
$REA inspect-electron-fuses $W/x/signal-8.36.0/opt/Signal/signal-desktop --format json
$REA analyze-javascript-application $W/x/signal-8.36.0/opt/Signal/resources/app.asar \
  --source-path bundles/main.js --source-path bundles/preload/main.js --max-heap-mb 2048 \
  --detail summary --evidence_output $W/signal-js.bundle.json --format json
```
