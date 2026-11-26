# Starts Triage's CAD engine inside FreeCADCmd (ROADMAP P2-2):
#
#   FreeCADCmd triage_cad_engine.py --pass --connect <endpoint>
#
# FreeCAD imports this file as a module (its folder is on sys.path), so the engine
# runs here and the exit code reaches FreeCADCmd through SystemExit.
import sys

from triage_cad.host import main

sys.exit(main())
