# REA evidence ledger

Every REA result behind the teardown reports, recorded on 2026-11-23 with REA
6.7.0 built from `noboishraque/rea`. The raw Evidence files were not committed:
one of them is about 290 MB, and the downloaded artifacts belong to their
authors. Run `scripts/research/teardown.sh` to regenerate them. The **artifact
SHA-256** column lets you confirm that a regenerated run analyzed the same bytes.

Confidence column: **observed** means REA read it from the artifact.
**derived** or **inferred** means REA or we concluded it from observations.

| # | Target | REA operation | Evidence ID | Parent Evidence ID | Artifact SHA-256 | Finding (confidence) |
|---|---|---|---|---|---|---|
| 1 | VSCodium install dir | inspect_desktop_application → summary view | `ev_3d9ffff8f2f34752ef4d7fab6c5554a4a8467c40b3c02ccc7f7e03ab329f5f5c` | `ev_52ce98edf936e4c13a11ee28dccabda7b55109b56cabaea8812edcb1a3d1f733` | `e170e205cdfbdadd22fe04340a3baa474267959fb41e4579a8207578e4c3eba4` | 2,998 files; only a .NET candidate (PSReadLine); no app.asar (observed) |
| 2 | VSCodium `codium` ELF | inspect_electron_fuses | `ev_9e961b91ddf8b38be5900aeaa1896b4eba0e38c5ead828f380fad5b62df34203` | – | `9ecc59968492b5139d37b2de89496832655d2caeae1c7229cecb706006aceb9a` | RunAsNode on, OnlyLoadAppFromAsar off, Inspect on (observed) |
| 3 | VSCodium app, 15 selected sources (13 JS) | analyze_javascript_application (partial: 21 MB renderer timed out) → summary view | `ev_656bdea4002dabbc7c4c414b7246b88bb40ac65370f02413cb0d4e4b1b2b813e` | `ev_73b0c7d0953aeb04703f88c72afef5810f15f251f2f52262f79dfcb049845a87` | `576b9e0acffbae7b7d011f624c1582a1aa0c892acc53f9c4653182b09b1a36ef` | 3 BrowserWindows, 1 contextBridge API, 10 IPC ops (9 dynamic), 14 sender checks, 1 utilityProcess (observed; partial coverage) |
| 4 | VSCodium preload | inspect_analysis_view (javascript-facts) | `ev_ab79569d73d4030a37a437d2a435e86010aec8c9aae51510eae95396a325f4b7` | `ev_73b0c7d0953aeb04703f88c72afef5810f15f251f2f52262f79dfcb049845a87` | `576b9e0acffbae7b7d011f624c1582a1aa0c892acc53f9c4653182b09b1a36ef` | `window.vscode` with 26 members, 0 unknown; literal channel `vscode:fetchShellEnv` (observed) |
| 5 | Blender install dir | inspect_desktop_application → summary view | `ev_4823dc1ec58a8a5a0f5df47f5c0aaf57d23e120097ef6853aef94d38da5eaf0b` | `ev_84bb45f2c6a66a68be224b96d7b9ea283a48911bddb1579f2dc3b5d877f9ffe8` | `4f49155dcb8b9558f208ee5438a3faedfa42de19218517b8169ee46021fd9d20` | 4,870 files; probe coverage partial (observed) |
| 6 | `blender` ELF | inspect_native_exports | `ev_84a3cd60a918dc290e59a6fc8b51b7b67cfd4fd0764fc044c8612d9123ebe3eb` | – | `baaa36cb5d7a35092388e6d123739b0829012c252b0705bc2debec292e4ebffb` | 1,686 exports: CPython C API plus 37 `PyInit_*` (observed); CPython statically linked (inferred) |
| 7 | `blender` ELF | inspect_elf_notes | `ev_b9ffdbae7507bad934c3dabda0025108ced25b4ce7630787bc6110ccf4c3e91a` | – | `baaa36cb5d7a35092388e6d123739b0829012c252b0705bc2debec292e4ebffb` | GNU build-id `47dadef2…`, ABI tag, annobin attributes (observed) |
| 8 | KiCad install tree | inspect_desktop_application → summary view | `ev_eb34c99b7461a6403f9b58510ae05cc5cbb9d73bec19240146080396f346c208` | `ev_3578cdb77f1201d6c81394aad7ca84dec791cdd78f6b05bc59707c83e7cc60d2` | `7fd770816e1d011b1201e57a9395744e277a96cf82f3dfc053bef8001456753f` | 331 files; no runtime family matched (observed) |
| 9 | `_pcbnew.kiface` | inspect_native_exports | `ev_638df9fa81a85f3f1150a66ed6412bfba81445f764b9d034d6a17836a7a81765` | – | `842e3516ebd7bf23a81ab9e08e5309dee2aa62518bcb32e524b076922ea4c0f4` | `KIFACE_1`, `PyInit__pcbnew`, tinyspline, zint (observed) |
| 10 | `_eeschema.kiface` | inspect_native_exports | `ev_7e581d33fc23c1ffafeb6f6fc8a202f4bae2c8db7eb3e230126c2bd72db841a5` | – | `764e1e2f769200e4bf3a7b16e021a914c733ab2fb85fc4b1f8632d5e5a546bc6` | `KIFACE_1` (observed); ngspice loaded by dlopen (strings observed, loading inferred) |
| 11 | `_kipython.kiface` | inspect_native_exports | `ev_a11a78dfcd68e6401044497c063ffe3610b3ec22b5516874330489b26c8b9b7d` | – | `d70bd5d83e7dab69939caf2ffe94d034be44ab7c261cba38052a447c41aa5e61` | `KIFACE_1` plus boost.context (observed) |
| 12 | `kicad-cli` | inspect_native_exports | `ev_92aa78a8a1bfa8c0e96e4b2ae7137f19aa108d415cad9dc8a5339f7d7ac9669a` | – | `a2625a7d5c3fc5be5e892927d0c0580ff1583f7afff32fc6e0f615bd316a7481` | small wx-only executable; subcommands from strings (observed) |
| 13 | `kicad` | inspect_native_exports | `ev_4dc6243e7271451db7f659637c2fd8bb60e5f28c5fa3537a725fce05001ccb5c` | – | `f410147f447607a2108c174f9664ac13c2e207dccfa2054a9dff29bd4cb7ce3b` | project manager executable (observed) |
| 14 | `libkiapi.so.10.0.8` | inspect_native_exports | `ev_cc5eca27e0b1bab5461a494a6216b2368166c94c40857f279e293b138889e8a1` | – | `2065cfe9e4126d42e43bb60a4c319b3380f04534207b5425a5748e1b1c162ffe` | 6,486 exports; 15 `.proto` descriptor tables (observed) |
| 15 | `libkicommon.so.10.0.8` | inspect_native_exports | `ev_bff95f90b46a59629b632e7660ecdaaa0e8e58c98bc07fded610387959b9d3a8` | – | `a8224513f95e4c7bc59a46ee1b6c956c3c9cd67ad9f1e2fa970e0135ffdf594f` | `KICAD_API_SERVER`, nng, `ipc://{}` (strings observed; UI-thread dispatch inferred) |
| 16 | `libkigal.so.10.0.8` | inspect_native_exports | `ev_99ce2404cb5c07861c252dc8cb02ec2b3ae1402d3a75e08c73bf6c85b10cd5f4` | – | `ff783848a48d10c42cf030bfcada0216b2943450fb575c6eefd76a7b210c2705` | GLAD OpenGL loader, Cairo (observed) |
| 17 | `libngspice.so.0.0.9` | inspect_native_exports | `ev_969cdab6dd8f6b9a3952222fc7ec697a382dbc11ea265a27cf03062c26f3304f` | – | `e69c2f217188e6ec8537b48983492950022e85a4c4adbd72a4faf4060445e3a2` | 16-function shared API incl. `Init_Sync`, `SetBkpt`, `Init_Evt` (observed) |
| 18 | `libsimavr.so.2` | inspect_native_exports | `ev_9e9806093b39599c77a9e0f77b30543c3241e01febb87bcd51de97b524df644f` | – | `62eaad619b6c6ce33aca27962aefcfc85aec1314ef48be86bbe60b5c49179a03` | 100 `avr_*`: IRQ graph, cycle timers, GDB, VCD (observed) |
| 19 | `libmujoco.so.4.0.1` | inspect_native_exports | `ev_d12bb2a93ce92d617986cdfad6523256cea5183423647a0b1aa2aa51a9a79cb3` | – | `0863b0c75c57512842e23f5ff6fd2d5f08b6451f17988edaaf7530a3a6e7cad1` | 822 exports; `mjs_` 158, `mjcb_` 8, `mjb_` 25 (observed) |
| 20 | Renode install dir | inspect_desktop_application → summary view | `ev_f507160c6bad80de56cdb7a6b5585b4bee84e0928034ab7ae120a09c2027e4ff` | `ev_4cd29ab8b642503296eea6b0c91d83f8e00ec4500e9ee0ed51c1af6b1d222911` | `dbdd7a366b20fdede8dca9f5774b067fcb719f41192b1da2381d77aa8ea74a2d` | 2,741 files; 482 managed assemblies (observed) |
| 21 | Renode `Infrastructure.dll` | inspect_managed_artifact | `ev_419d62abb5cca5d4f27af836632b9b95ecfe10403c33dfe85903e15b33f1ec22` | – | `11078524aa69cf173588aa60e79ff386846e1246297edc82d1493d0a86056310` | .NET 8; 6,794 TypeDef / 45,476 MethodDef rows (observed) |
| 22 | Renode `Renode.dll` | inspect_managed_artifact | `ev_9ee1da60d8a30d84ff7c6acef6e7d0e1c3e0fca0facf0f43aa22373601f18dcb` | – | `37652584bfbec2973fa64b232579726fe9a5a01eab84b43e7cb924052b9f3b8e` | assembly version 1.16.1.4514 (observed) |
| 23 | Renode `CoSimulationPlugin.dll` | inspect_managed_members | `ev_4065222b67e5f19a43359a8563c24f1cd6cce02e0d0d12c0e87cbc343798b363` | – | `1cd96a1090a29406dd67708a1b04af38b0cf703fb87d0ef8676f259feb68019c` | `ProtocolMessage`, `ActionType` vocabulary, library and socket connections (observed) |
| 24 | Renode `Infrastructure.dll` | inspect_managed_members (type-selected) | `ev_3a7365603f25b0fb43247e4b466423be30fc6a184d60a10c5f7f0c16fa686352` | – | `11078524aa69cf173588aa60e79ff386846e1246297edc82d1493d0a86056310` | **refused**: exceeds the 64 MiB representation budget (limitation observed) |
| 25 | avr8js 0.21.1 | analyze_javascript_application → summary view | `ev_0af2d817f8b454f6d9667ad0829c2230979583b0f47134805f139e1487ee57d9` | `ev_df0c22e6b3b8a41d25d280f84b3df33a43227a2e74ffe46f8b3a35ddabfcce69` | `fa76d2ced5c825c49f5b96e34e9ce1a3f35b247144dd5477886b58e794382cbf` | 72 JS files parsed; module inventory (observed) |
| 26 | rp2040js 1.4.2 | analyze_javascript_application → summary view | `ev_48b809d1d0313633101561b268527938b8128ae19fcc8b30c81f6986043c2ef3` | `ev_0021109379242fffeb6673e89998bad060eb6d77341e95429dcdf89aee8cd233` | `e577daf3240c50ceb65995d7909c651e4e932eff5256840b0bb24f6389cd5187` | 208 JS files parsed; complete application coverage (observed) |
| 27 | avr8js `gpio.js` | inspect_analysis_view (item) | `ev_b19919ac5076b38b0adaebdd5e07488601cf888b379d5811a08e2e7f90c676cf` | `ev_df0c22e6b3b8a41d25d280f84b3df33a43227a2e74ffe46f8b3a35ddabfcce69` | `fa76d2ced5c825c49f5b96e34e9ce1a3f35b247144dd5477886b58e794382cbf` | exports `AVRIOPort`, `PinState`, `PinOverrideMode`… (observed) |
| 28 | rp2040js `simulator.js` | inspect_analysis_view (item) | `ev_fa0125889f720c185f3e4a0b87a73d918aac8ab793e457372a27e510d8554787` | `ev_0021109379242fffeb6673e89998bad060eb6d77341e95429dcdf89aee8cd233` | `e577daf3240c50ceb65995d7909c651e4e932eff5256840b0bb24f6389cd5187` | exports `Simulator` (observed) |

Facts from `readelf -d` (NEEDED, RUNPATH), `strings` and package metadata
(licenses, versions) came from standard format-aware tools, not REA. The reports
label them **[O]**, observed in shipped files.

## Cost of the analysis (for planning future runs)

| Run | Wall time | Notes |
|---|---|---|
| VSCodium JS graph, 15 selected sources (13 JS) | 18 min 27 s (19 min 22 s CPU) | analyzer worker reached ~3.3 GB RSS; the 21 MB `workbench.desktop.main.js` timed out at 900 s |
| All other REA runs | seconds each | exports, notes, fuses, managed metadata, desktop inventories |

## Open questions (bounded, not answered)

1. Renderer-side IPC and webview facts in VS Code's 21 MB workbench bundle. Re-run with a 60-minute deadline.
2. Renode core peripheral and time API through REA. Blocked by the 64 MiB budget; use the source instead.
3. Consumer of Blender's bundled `libJolt.so`.
4. Runtime confirmation of KiCad's API threading (needs a running KiCad and an API client).
