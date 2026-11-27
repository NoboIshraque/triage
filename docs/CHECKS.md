# Owner checks

> Everything only **the owner** can do: runs on the Windows laptop, exit demos,
> measurements on a real GPU, settings on GitHub. Each check has step-by-step
> instructions. **Claude** adds a check when a work package needs one and keeps
> the steps current. **The owner** marks a check done; Claude never does.
>
> **To mark a check done:** change its `- [ ] Done` line to `- [x] Done`, then add
> the date and what you saw, for example
> `- [x] Done 2026-11-28: all steps worked; board 48 fps, schematic 60 fps`,
> and put the date in the **Done** column of the "At a glance" table.
> If something went wrong, write it there too (or tell Claude in a session).
> Claude reads this file at the start of every session and acts on what you wrote.

**Current build branch:** `claude/unified-engineering-platform-jn5rmk`, the
**default branch** (Claude updates this line when a session works on another
branch). P0 to P3 are **merged into it**; phase **PA** (the Arduino IDE built
in) is being built on `claude/nifty-babbage-mixxtm` and is merged once CI is
green: C7 needs a build made after that merge.

## At a glance

| Check | What | Needed for | Blocks the next phase? | Done |
|---|---|---|---|---|
| [C1](#c1--launch-a-windows-build-p0-7) | Launch a Windows build | P0-7 | no | yes, 2026-11-24 |
| [C2](#c2--triages-own-github-sign-in-and-copilot-p0-8) | Triage's own GitHub sign-in and Copilot | P0-8 | no | yes, 2026-11-25 |
| [C3](#c3--m1-exit-demo-the-circuit-inside-triage-p1) | M1 exit demo: the circuit inside Triage | P1 (milestone M1) | no | |
| [C4](#c4--frame-rates-on-your-gpu-dv-22) | Frame rates on your GPU (the 60 fps check) | P1-4, P2-3 | no | |
| [C5](#c5--the-3d-tab-and-the-enclosure-p2) | The 3D tab and the enclosure | P2 | no | |
| [C6](#c6--m2-exit-demo-the-smart-fan-runs-in-one-window-p3) | M2 exit demo: the Smart Fan runs in one window | P3 (milestone M2) | no | |
| [C7](#c7--pa-exit-demo-the-arduino-ide-built-into-triage-on-your-board-pa) | PA exit demo: examples, Upload to your Nano or Mega, Serial Monitor, Library and Boards Managers (ESP32) | PA (PA-3, PA-5, exit demo) | no | |

"Blocks the next phase: no" means Claude can start the next phase before you run
it. A milestone (M1, M2 …) only counts as finished once you have run its exit
demo on Windows (GUIDELINES §4).

## Before any check: get a build and the example project

You need two things: **a Windows build of Triage** and **the Smart Fan example
project**, both from the current build branch (above).

**A. The Windows build** (about 5 minutes, or 35 if you have to start a build)

**Shortcut, the nightly:** open
<https://github.com/NoboIshraque/triage/actions/workflows/nightly.yml>
(**Actions** → **Nightly**), click the newest run with a green check mark and
download **triage-Windows-nightly** under **Artifacts** (kept 3 days). It is
built from the default branch at 03:17 UTC on days something was merged into
it. Then continue at step 5. If there is no green nightly yet, or the work you
want isn't merged, use the steps:

1. Open <https://github.com/NoboIshraque/triage/actions/workflows/app.yml>
   (the repository → **Actions** tab → workflow **App** in the left list).
2. Click the **Branch** filter above the list of runs and pick the current build
   branch.
3. Click the newest run with a **green check mark**. Scroll down to
   **Artifacts** and click **triage-Windows** to download it. Builds are kept
   for **1 day**.
4. No green run, or its artifacts expired? Click **Run workflow** (top right of
   the run list), choose the current build branch under **Use workflow from**,
   and click the green **Run workflow** button. Wait about 35 minutes for a
   green check, then go back to step 3.
5. Unzip `triage-Windows.zip`. Inside are two ways to run Triage; use either:
   - **Installer:** run `TriageUserSetup-x64-….exe`. It installs for your user
     only and needs no admin rights.
   - **Portable:** unzip `Triage-win32-x64-….zip` anywhere and start
     `Triage\Triage.exe`.
6. Windows SmartScreen warns that the app is unrecognized, because the build
   isn't signed yet. Click **More info**, then **Run anyway**.

**B. The example project**

1. Open <https://github.com/NoboIshraque/triage>. If the line at the top of
   this file says the work is merged into the default branch, keep the branch
   GitHub shows; otherwise click the branch menu and pick the current build
   branch.
2. Click the green **Code** button → **Download ZIP**, and unzip it. If you use
   git instead: `git clone https://github.com/NoboIshraque/triage` then
   `git checkout <current build branch>`.
3. The project is the folder `examples\smart-fan`. **Copy it somewhere else**
   (for example `Documents\smart-fan-test`) and use the copy: the checks edit
   and save its files.

**Opening the project in Triage:** **File → Open Folder…**, pick the
`smart-fan` folder, and click **Yes, I trust the authors** if Triage asks. Then
click the **Triage icon** at the top of the left-hand bar (the T logo) and click
**Open Engineering Layout**. The window splits into **Code, Schematic, Board,
3D** and **Sim** tabs, and the status bar at the bottom shows "KiCad engine:
connected" and "FreeCAD engine: connected".

**Every Triage action has a button or a menu entry** (the owner's rule,
2026-11-27): the **Triage** menu in the menu bar lists all of them, the tabs have
toolbar buttons, and the Schematic tab has a right-click menu. (The **Triage**
menu sits between **Edit** and **Selection**.) Typing a command
(**F1**, then part of its name, **Enter**) still works if you prefer it.

---

## C1 · Launch a Windows build (P0-7)

- **Why:** ROADMAP P0-7, done-when: "the owner downloads the nightly and
  launches it on their Windows laptop".
- **Steps:** get a build (A above), start it, open a folder with a
  `triage.toml`, **Open Engineering Layout**, **Benchmark Hello Engine**.
- [x] Done 2026-11-24 (reported to Claude; recorded in STATUS.md before this
  file existed)

## C2 · Triage's own GitHub sign-in and Copilot (P0-8)

- **Why:** ROADMAP P0-8: GitHub should say "Triage", not "Visual Studio Code",
  and Copilot should work with that sign-in.
- **Steps:** register the OAuth app on GitHub and give Claude its Client ID;
  then in Triage **Accounts** (bottom left) → **Sign Out**, **Sign In** again,
  and send a Copilot prompt. Full history: STATUS.md, "P0-8".
- [x] Done 2026-11-25 (reported to Claude: "the copilot signup works now";
  recorded in STATUS.md before this file existed)

## C3 · M1 exit demo: the circuit inside Triage (P1)

- **Why:** ROADMAP M1 exit demo: "open the Smart Fan KiCad project in Triage,
  see schematic and board in tabs, move a part, rename a net and watch
  `board_pins.h` and the code diagnostics update. The files still open in stock
  KiCad. The owner runs it on Windows." P1 passed all of this in CI; this is the
  run on your laptop that finishes milestone M1.
- **You need:** a build and the example project (above), about 20 minutes.
  Optional: KiCad 10 installed, for step 9.
- **Steps:**
  1. Open the `smart-fan` copy in Triage and click **Open Engineering Layout**
     (see "Opening the project" above). **Check:** the **Schematic** tab shows
     the circuit and the **Board** tab shows the circuit board, both drawn
     sharply; the status bar says "KiCad engine: connected".
  2. **Zoom and pan** in both tabs: mouse wheel zooms, dragging with the middle
     mouse button (or the right button) pans. **Fit** in the tab's toolbar
     shows everything again. **Check:** it moves smoothly.
  3. **Cross-probe:** in the **Board** tab, click the part labelled **Q1** (the
     transistor). **Check:** Q1 is highlighted in the **Schematic** tab too.
     Clicking Q1 in the Schematic tab highlights it on the board.
  4. **Move and rotate:** in the Board tab, drag Q1 a little to one side, then
     press **R** to rotate it. **Check:** it moves and turns, and the Board tab's
     toolbar shows **modified**.
  5. **Undo and redo:** click **Undo** in the Board tab's toolbar twice, then
     **Redo** twice. **Check:** Q1 goes back and comes again.
  6. **Save:** press **Ctrl+S** (or **Save** in the toolbar). **Check:** **modified**
     goes away from the toolbar.
  7. **Rename a net:** in the **Code** area open `firmware\generated\board_pins.h`
     (Explorer: the files icon in the left-hand bar). Then, in the
     **Schematic** tab, **right-click** the wire or label of the net `FAN_PWM`
     and click **Rename Net "FAN_PWM"…** (or click **Rename Net…** in the
     Schematic tab's toolbar and type `FAN_PWM`, Enter), type `MOTOR_SPEED`,
     press Enter. **Check:** within about 2 seconds
     `board_pins.h` says `MOTOR_SPEED` where it said `FAN_PWM`. Also open
     `firmware\src\main.cpp` and hover the mouse over the pin name `BUTTON`
     (in `setup()`, about line 59) or `TEMP_SENSE` (in `loop()`, about line
     81): a box shows its net, the Arduino pin and what the pin can do.
     (`main.cpp` still uses the old name `FAN_PWM`; renaming code is later
     work.)
  8. **The KiCad fallback window:** click **Edit in KiCad** in the Board tab's
     toolbar (or right-click the board → **Edit in KiCad**). KiCad's own board editor
     opens on the same file. If KiCad first asks how to set up its global
     library tables, choose the option to create an **empty** table (the Smart
     Fan carries its own libraries). Move any part in KiCad and save there
     (**Ctrl+S**). **Check:** Triage's Board tab shows the change within about
     2 seconds. Close KiCad's window.
  9. *(Optional)* Open `electronics\smart-fan.kicad_pro` in your own KiCad 10.
     **Check:** the schematic and board open with your edits and no errors.
- **Tell Claude:** which steps worked, anything that looked wrong or slow, and
  screenshots of anything odd (**Win+Shift+S** takes one).
- [ ] Done

## C4 · Frame rates on your GPU (DV-22)

- **Why:** ROADMAP P1-4 asks for 60 frames per second when drawing. CI and
  Claude's sessions have no graphics card, so they only check that frames are
  drawn ([DV-22](DEVIATIONS.md)). Your laptop is the only place this can be
  measured.
- **You need:** the same build and project as C3, about 5 minutes. **Plug the
  laptop in** (on battery, Windows slows the graphics card down).
- **Steps:**
  1. Open the project and click **Open Engineering Layout**.
  2. Click **Triage → Diagnostics → Benchmark Schematic and Board Views** in the
     menu bar. A notification at the
     bottom right shows, for example, `schematic: 58 fps (average 17.1 ms,
     worst 25.3 ms) · board: 60 fps (…)`. Write both down.
  3. Make the Board tab big: double-click its tab title (the word **Board** at
     the top of the tab). Run the same command again and write the numbers
     down. Double-click the tab title again to go back to the layout.
  4. Click **Triage → Diagnostics → Benchmark the 3D View**. The notification shows `3D view: …
     fps`. Write it down.
  5. Find your graphics card's name: **Ctrl+Shift+Esc** (Task Manager) →
     **Performance** → **GPU**; the name is at the top right.
- **Tell Claude:** the numbers from steps 2–4 and the graphics card's name. 60
  fps or close to it is the goal; well below that is worth fixing.
- [ ] Done

## C5 · The 3D tab and the enclosure (P2)

- **Why:** P2 passed in CI on Windows and Linux (the 3D tab, the enclosure made
  from the board, the fit checks). This is your look at it on your laptop. It
  isn't a milestone demo (M2 comes after P3), so it's optional, but it's the
  best way to find what feels wrong.
- **You need:** a build and the example project (above) from **2026-11-26 or
  later**, about 15 minutes. Optional: a slicer (PrusaSlicer, Cura, Bambu
  Studio) and FreeCAD 1.1.
- **Steps:**
  1. Open the project and click **Open Engineering Layout**. **Check:** the
     **3D** tab shows the fan's rotor and a closed box (the enclosure); the
     status bar says "FreeCAD engine: connected".
  2. **Move around:** in the 3D tab, drag with the **middle mouse button** to
     orbit, **Shift + middle drag** (or the right button) to pan, the **wheel**
     to zoom. On a touchpad, **Alt + left drag** orbits. **Home** (or **Frame
     All** in the toolbar) shows everything; **Front**, **Right**, **Top** and
     **Iso** in the toolbar switch views.
  3. **The panel:** click an empty spot in the 3D view, then press **N** (or
     click **Panel** in the 3D tab's toolbar; in a narrow tab the toolbar may be
     cut off at the right). In a narrow tab the panel covers part of the view;
     press **N** again to hide it.
     The outliner lists the documents and their objects, each with an eye icon
     to hide or show it. Click **Enclosure**. Its properties appear below.
  4. **See the board inside:** in the properties, set **ExplodeLid** to `40 mm`
     and press **Enter**. **Check:** the lid lifts and the green circuit board
     with its parts shows inside. Set it back to `0 mm` before step 6 (the fit
     check measures the lid where it is).
  5. **Change the wall:** set **WallThickness** to `3 mm` and press **Enter**.
     **Check:** within about a second the enclosure gets thicker walls (the
     status line under the view says what changed and how long it took).
  6. **A part that doesn't fit:** click **Part Height…** in the 3D tab's
     toolbar, click **R1** in the list, type `60`, Enter. (Or select R1 in the
     panel's list under the board, and type 60 in its **Height above board**
     row.) **Check:** a tall block pokes through the lid, the enclosure turns
     red, and the **Problems** panel (click the problems count at the bottom
     left) says "Enclosure collides with R1". Do it again with `R1` and `0`: the
     problem goes away.
  7. **Print files:** click **Export STL** in the 3D tab's toolbar (it may be
     cut off in a narrow tab; double-click the tab title **3D** to make the tab
     big). **Check:** `mechanical\exports\base.stl` and `lid.stl` appear.
     *(Optional)* Open them in your slicer.
  8. *(Optional)* Open `mechanical\enclosure.FCStd` in FreeCAD 1.1. **Check:**
     it opens and shows the enclosure.
- **Tell Claude:** what worked, what felt awkward (navigation, the panel
  covering the view in a narrow tab, colours, speed), and screenshots.
- [ ] Done

## C6 · M2 exit demo: the Smart Fan runs in one window (P3)

- **Why:** ROADMAP M2 exit demo: "PLAN §3 steps 1–6 and 9 inside Triage … The
  owner runs it on Windows." P3 runs the Smart Fan's firmware on an emulated
  Arduino Uno, with its circuit, the fan's rotor in MuJoCo and the room's
  temperature, inside the **Sim** tab; the rotor turns in the **3D** tab; the
  scope picker runs just the circuit, just the code or just the mechanism; the
  scenarios run as tests. CI checks all of it on Windows and Linux; this is the
  run on your laptop that finishes milestone M2 (together with C3, M1).
- **You need:** a build and the example project (top of this file) from the
  current build branch, made **after phase PA was merged** (the Arduino engine
  is then inside Triage), about 30 minutes. **No Arduino IDE is needed any
  more:** Triage builds the firmware with its own compiler. (If you installed
  the Arduino IDE for an earlier build of this check, you can keep it or
  uninstall it; Triage doesn't use it.)
- **Steps:**
  1. Open the `smart-fan` copy in Triage and click **Open Engineering Layout**
     (see "Opening the project"). The bottom-right tab is **Sim**. If the
     layout is cramped, double-click the **Sim** tab title to make it big
     (double-click again to go back).
  2. **Run the whole device:** in the Sim tab, leave **Scope** on **Whole
     device** and **Speed** on **1×**, and click **Run**. **Check:** the status
     line says "Building the firmware…" for a few seconds, then shows
     `t = … s · 1.00× real time · Whole device` with the time counting up. The
     status bar at the bottom says "Sim: Whole device · … · 1.00× real time".
     The very first build after installing Triage takes up to a minute longer:
     Triage copies its AVR compiler into your Arduino folder
     (`%LOCALAPPDATA%\Triage\Arduino`). *If the firmware doesn't build:* tell
     Claude the exact message (the **Arduino** output channel, **View →
     Output**, shows the compiler's output).
     *If the ratio stays below 1.00×:* tell Claude the number. On CI's Windows
     machine (4 slow cores, no graphics card) the app reached about 0.7×,
     while the same firmware runs at 1.3× outside the app there; your laptop
     is the real measure.
  3. **The display and the serial monitor:** under **Display**, the OLED
     shows the temperature (about `24.0C 0%`) and `AUTO`. The **Serial
     monitor** prints a line every 0.1 s, like `t=24.0 reading=491 duty=0%
     mode=AUTO`.
  4. **Warm the room (PLAN §3 step 6):** in **Environment**, drag **Room
     temperature** to **35 °C**. **Check:** within a second the OLED shows
     `35.0C 80%`, the plot under **Instruments** shows the fan's duty rising to
     80%, the motor current and the rotor's speed (about 2,600 rpm), and in the
     **3D** tab the fan's rotor turns and the **status LED (D2)** on the board,
     beside the OLED's header, glows red. (If the enclosure hides the board,
     click the eye next to **Enclosure** in the 3D tab's list.) Take a
     screenshot (**Win+Shift+S**).
  5. **Too hot:** drag the temperature to **40 °C**. **Check:** the OLED adds
     `HOT` and shows 100%, and the status LED in the 3D tab blinks.
  6. **The Mode button:** under **Parts**, click **Press** next to **SW1**
     once. **Check:** the OLED says `MAX`. Press it again: `OFF`, the rotor
     in the 3D tab slows to a stop and the status LED goes dark. Press once
     more for `AUTO`.
  7. **Pause, step, stop:** click **Pause** (the Run button): the time stops
     and so does the rotor. Click **Step 10 ms** a few times: the time moves 10
     ms each click. Click **Run** to go on, then **Stop**.
  8. **Circuit only:** pick **Scope → Circuit only** and click **Run**. The
     firmware doesn't run: **Stubs at the scope's edge** lists `A1.D9.drive:
     control` and others. Drag **A1.D9.drive PWM duty** to 0.8. **Check:** the
     plot shows the motor current and the rotor's speed rising (no OLED: no
     firmware). Click **Stop**.
  9. **Code only:** pick **Scope → Code only** and click **Run**. Only the
     firmware runs; the **Virtual I/O** panel stands in for the circuit. Drag
     **TEMP_SENSE (A0)** to **3.03 V**. **Check:** the OLED shows about `35.0C
     80%`, the **FAN_PWM (D9)** indicator shows about 80% and **STATUS_LED
     (D13)** is lit. Click **Press** next
     to **BUTTON (D2)**: the OLED says `MAX`. Click **Stop**.
  10. **Mechanism only:** pick **Scope → Mechanism only**, click **Run**, and
      drag the **J1.torque** slider to about **2 mN·m**. **Check:** the plot
      shows the rotor's speed rising to about 1,900 rpm and the rotor turns in
      the 3D tab. Click **Stop**.
  11. **The saved scope:** pick **Scope → Power stage only** (from
      `simulation/scopes/power-stage.toml`) and click **Run**: D9 is an 80%
      PWM generator and the rotor spins up. Click **Stop**.
  12. **Scenarios (PLAN §3 step 9):** at the bottom of the Sim tab, click **Run
      all scenarios**. **Check:** after about half a minute all six show a
      green ✓, `fan reacts to overheating` and `the status LED shows the fan
      running` among them; each lists its checks.
  13. **The Test Explorer:** click the flask icon in the left-hand bar
      (**Testing**). **Check:** **Triage scenarios** lists the six scenario
      files; click the ▶ next to **Triage scenarios**: all pass.
- **Tell Claude:** which steps worked; the real-time ratio in step 2 (it
  should stay at 1.00×; with Speed **max** it shows how fast your laptop can
  go: tell Claude that number too); anything slow, odd or confusing in the Sim
  tab; and screenshots.
- [ ] Done

## C7 · PA exit demo: the Arduino IDE built into Triage, on your board (PA)

- **Why:** ROADMAP PA exit demo: "on the Windows laptop, without the Arduino IDE
  installed: open Blink from File → Examples, upload it to a real Uno with the
  Upload button, install a library from the Library Manager, and install the
  ESP32 boards from the Boards Manager". You have an **Arduino Nano or Mega**
  (2026-11-27), so this check uses that. It also covers PA-3's owner check (the
  real board's serial output) and PA-5's (an ESP32 compile). CI checks the same
  steps with an emulated Uno (no real board there).
- **You need:** a build from the current build branch made after PA was merged
  (the nightly, or the App workflow's **triage-Windows**; see the top of this
  file), your **Nano or Mega** and its **USB cable**, an internet connection (the
  Library and Boards Managers download from Arduino), about 30 minutes. The
  Arduino IDE doesn't need to be installed; if it is, close it (two programs
  can't use the board's port at once).
  - **A Nano clone** usually has a CH340 USB chip. Windows 10 and 11 install its
    driver by themselves (through Windows Update) the first time you plug it in.
    If the board never shows up in step 3, open **Device Manager** (right-click
    the Start button) and look under **Ports (COM & LPT)**: tell Claude what it
    lists, or what's under **Other devices** with a yellow mark.
- **Steps:**
  1. **Open an example.** Start Triage. Click **File → Examples…** in the menu
     bar (or the **Triage** menu → **Examples…**). A list opens: type `Blink` in the box at the top (or
     scroll to **01.Basics**), and click **Blink** (under **01.Basics**). **Check:** a new Triage window opens with the project
     **Blink** (the Triage icon at the top left of the activity bar shows it), and
     `Documents\Triage\Blink\` now holds `triage.toml` and `Blink\Blink.ino`.
  2. **Try it in the simulator first.** In the new window, click the **Triage**
     icon, then **Open Engineering Layout**. In the **Sim** tab pick **Scope →
     Code only** and click **Run**. **Check:** under **Virtual I/O**, the **D13**
     indicator switches between **H** and **L** once a second. Click **Stop**.
  3. **Pick your board and port.** Plug the board in. At the bottom left of the
     window, click the board's name in the status bar (it says **Arduino Uno**).
     **Check:** a list opens; under **Plugged in** your board shows with its
     port (for example `COM5`). A genuine board shows by name; a clone may show
     only under the port list in the next step.
     - **Nano:** click **Arduino Nano**. Triage asks for the **Processor**: pick
       **ATmega328P** for a recent genuine Nano, or **ATmega328P (Old
       Bootloader)** for most clones (if unsure, try Old Bootloader first). Then
       pick the port (`COM…`).
     - **Mega:** click **Arduino Mega or Mega 2560**, pick **ATmega2560 (Mega
       2560)** as the Processor, then the port.
     **Check:** the status bar now shows your board and port, for example
     `Arduino Nano · COM5`.
  4. **Upload.** Open `Blink\Blink.ino` (Explorer, the files icon at the top of
     the left-hand bar). Click the **→** button (**Upload to the Board**) at the
     top right, above the code (the **✓** beside it is **Build**). **Check:** the
     status bar shows a spinning icon while it builds and uploads; a message
     says "Uploaded to … on COM…"; the board's own LED (marked **L**) blinks once
     a second. *If it fails:* the message says why in plain words; for a Nano,
     try the other Processor (step 3). Tell Claude the message, and copy the
     **Arduino** output channel (**View → Output**, pick **Arduino** in the list
     at the top right of the panel).
  5. **The Serial Monitor.** Open another example that prints: **File →
     Examples…** → **01.Basics → AnalogReadSerial**. In its window, pick your
     board and port again (step 3), click **→** to upload, then click the
     **plug** button above the code (**Serial Monitor**), or **Triage → Serial
     Monitor**. In the panel, leave **9600 baud** and click **Connect**.
     **Check:** a number between 0 and 1023 appears several times a second (the
     board's unconnected A0 pin, so the numbers drift). Click **Disconnect**.
  6. **The Library Manager.** Click the **Arduino** icon in the left-hand bar
     (the books). In **Library Manager**, type `Adafruit SSD1306` in the search
     box and click **Search** (the first search downloads Arduino's library list,
     a few seconds). **Check:** **Adafruit SSD1306** is listed; click **Install**.
     **Check:** a message says it's installed; the project's `triage.toml` now
     has a line `libraries = ["Adafruit SSD1306@…"]`; **Installed** lists it with
     **Adafruit GFX Library** and **Adafruit BusIO**, which came with it. Its
     examples appear in **Examples** (click **Reload** there).
  7. **The Boards Manager and an ESP32.** In the same Arduino side bar, open
     **Boards Manager**. Click **More URLs…** and paste
     `https://espressif.github.io/arduino-esp32/package_esp32_index.json`, press
     **Enter**. Click **Refresh**. Type `esp32` in the search box and click
     **Search**. **Check:** **esp32** by Espressif Systems is listed; click
     **Install** (it downloads Espressif's compilers, a few hundred MB: this can
     take 5–15 minutes). **Check:** it shows **installed**. Then, in the Blink
     window, click the board's name in the status bar, pick **ESP32 Dev Module**
     (and its options, the defaults are fine) and **No port: build only**, and
     click **✓** (Build). **Check:** the Triage side bar's **Firmware** section
     says "Built for esp32:esp32:esp32…" with the flash used. (Uploading to an
     ESP32 and simulating it come in P4.)
- **Tell Claude:** which steps worked; your board (Nano or Mega, genuine or
  clone, and which Processor worked); the upload message if one failed;
  anything slow or confusing; screenshots (**Win+Shift+S**).
- [ ] Done

---

## Coming later

Claude adds full steps when the work package is built. From the ROADMAP:

- **PC exit demo and PC-6 (phone companion, after P3):** "Show on phone" from
  the laptop, then the simulation on your phone.
- **M3 exit demo (end of P4):** the ESP32 Smart Fan serving its dashboard over
  simulated Wi-Fi.
- **M4 and M5 exit demos (P6, P8).**

Decisions that are yours (not checks) are listed under **Open questions** in
[STATUS.md](STATUS.md); none of them blocks the build.
