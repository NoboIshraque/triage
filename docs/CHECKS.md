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

**Current build branch:** `claude/busy-ptolemy-ijnsz7` (the branch the newest
work is on; Claude updates this line when a session works on another branch).
Everything on it up to P2 is also **merged into the default branch**
(`claude/unified-engineering-platform-jn5rmk`, 2026-11-26), so the default
branch's nightly build and ZIP download have it too.

## At a glance

| Check | What | Needed for | Blocks the next phase? | Done |
|---|---|---|---|---|
| [C1](#c1--launch-a-windows-build-p0-7) | Launch a Windows build | P0-7 | no | yes, 2026-11-24 |
| [C2](#c2--triages-own-github-sign-in-and-copilot-p0-8) | Triage's own GitHub sign-in and Copilot | P0-8 | no | yes, 2026-11-25 |
| [C3](#c3--m1-exit-demo-the-circuit-inside-triage-p1) | M1 exit demo: the circuit inside Triage | P1 (milestone M1) | no | |
| [C4](#c4--frame-rates-on-your-gpu-dv-22) | Frame rates on your GPU (the 60 fps check) | P1-4, P2-3 | no | |
| [C5](#c5--the-3d-tab-and-the-enclosure-p2) | The 3D tab and the enclosure | P2 | no | |

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

**Running a command:** press **F1** (or **Ctrl+Shift+P**), type part of the
command's name (for example `Rename Net`), and press **Enter** on the command.
Triage's own commands start with "Triage:".

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
     (Explorer: the files icon in the left-hand bar). Then run
     **Triage: Rename Net in the Schematic**, type `FAN_PWM`, press Enter, type
     `MOTOR_SPEED`, press Enter. **Check:** within about 2 seconds
     `board_pins.h` says `MOTOR_SPEED` where it said `FAN_PWM`. Also open
     `firmware\src\main.cpp` and hover the mouse over the pin name `BUTTON`
     (line 10) or `TEMP_SENSE` (line 15): a box shows its net, the Arduino pin
     and what the pin can do.
     (`main.cpp` still uses the old name `FAN_PWM`; renaming code is later
     work.)
  8. **The KiCad fallback window:** click in the Board tab, then run
     **Triage: Edit in KiCad (Fallback Window)**. KiCad's own board editor
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
  2. Run **Triage: Benchmark Schematic and Board Views**. A notification at the
     bottom right shows, for example, `schematic: 58 fps (average 17.1 ms,
     worst 25.3 ms) · board: 60 fps (…)`. Write both down.
  3. Make the Board tab big: double-click its tab title (the word **Board** at
     the top of the tab). Run the same command again and write the numbers
     down. Double-click the tab title again to go back to the layout.
  4. Run **Triage: Benchmark the 3D View**. The notification shows `3D view: …
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
  6. **A part that doesn't fit:** run **Triage: Set a Part's Height (3D and Fit
     Checks)**, type `R1`, Enter, then `60`, Enter. **Check:** a tall block
     pokes through the lid, the enclosure turns red, and the **Problems** panel
     (**Ctrl+Shift+M**) says "Enclosure collides with R1". Run the command
     again with `R1` and `0`: the problem goes away.
  7. **Print files:** click **Export STL** in the 3D tab's toolbar (it may be
     cut off in a narrow tab; double-click the tab title **3D** to make the tab
     big). **Check:** `mechanical\exports\base.stl` and `lid.stl` appear.
     *(Optional)* Open them in your slicer.
  8. *(Optional)* Open `mechanical\enclosure.FCStd` in FreeCAD 1.1. **Check:**
     it opens and shows the enclosure.
- **Tell Claude:** what worked, what felt awkward (navigation, the panel
  covering the view in a narrow tab, colours, speed), and screenshots.
- [ ] Done

---

## Coming later

Claude adds full steps when the work package is built. From the ROADMAP:

- **M2 exit demo (end of P3):** the Smart Fan in one window: run the whole
  device, or just the circuit, the code or the mechanism.
- **PC exit demo and PC-6 (phone companion, after P3):** "Show on phone" from
  the laptop, then the simulation on your phone.
- **M3 exit demo (end of P4):** the ESP32 Smart Fan serving its dashboard over
  simulated Wi-Fi.
- **M4 and M5 exit demos (P6, P8).**

Decisions that are yours (not checks) are listed under **Open questions** in
[STATUS.md](STATUS.md); none of them blocks the build.
