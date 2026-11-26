# Runs FreeCAD's own Python test suites inside the staged FreeCADCmd (ROADMAP P2-1)
# and writes every test's result as JSON. tests/run.mjs starts it:
#
#   FreeCADCmd module_tests.py      with TRIAGE_TEST_SUITES=TestPartApp,TestPartDesignApp
#                                   and TRIAGE_TEST_OUTPUT=<results.json>
#
# The engine is FreeCAD without its GUI (ADR 0002), so a few test files import modules
# it doesn't have: pivy (Coin3D's Python binding, the 3D view's scene graph), Draft
# (a workbench the engine doesn't build) and PartDesign's involute gear (a GUI script).
# FreeCADGui gets no placeholder: test files import it to find out whether the GUI runs. FreeCAD's own runner would fail to load the
# whole suite then. Here those names are placeholders: importing them works, and a test
# that actually uses one is reported as skipped, with the module named. Every other
# test runs as FreeCAD's own runner runs it (unittest, the suite's module by name).
import json
import os
import sys
import time
import traceback
import types
import unittest

import FreeCAD

# Modules a GUI-less engine doesn't have, and why.
ABSENT = {
    "pivy": "pivy (Coin3D's Python binding) belongs to FreeCAD's 3D view, which the engine doesn't build",
    "pivy.coin": "pivy (Coin3D's Python binding) belongs to FreeCAD's 3D view, which the engine doesn't build",
    "Draft": "the Draft workbench is not built into the engine",
    "InvoluteGearFeature": "PartDesign's involute gear is a GUI script (it imports PySide), which FreeCAD installs only with its GUI",
}


class Absent(types.ModuleType):
    """Stands in for a module the engine doesn't have; using it skips the test."""

    def __init__(self, name, reason):
        super().__init__(name)
        self.__triage_reason__ = reason
        self.__path__ = []  # a package, so `from pivy import coin` resolves

    def __getattr__(self, attribute):
        if attribute.startswith("__"):
            raise AttributeError(attribute)
        return AbsentValue(f"{self.__name__}.{attribute}", self.__triage_reason__)


class AbsentValue:
    """Any attribute of an absent module: calling or using it skips the test."""

    def __init__(self, name, reason):
        self._name = name
        self._reason = reason

    def _skip(self, *args, **kwargs):
        raise unittest.SkipTest(f"uses {self._name}: {self._reason}")

    __call__ = _skip
    __iter__ = _skip
    __bool__ = _skip

    def __getattr__(self, attribute):
        if attribute.startswith("__"):
            raise AttributeError(attribute)
        return AbsentValue(f"{self._name}.{attribute}", self._reason)


def install_placeholders():
    present = []
    for name, reason in ABSENT.items():
        try:
            __import__(name)
            present.append(name)
        except ImportError:
            module = Absent(name, reason)
            sys.modules[name] = module
            parent, _, child = name.rpartition(".")
            if parent and parent in sys.modules:
                setattr(sys.modules[parent], child, module)
    return present


class Recorder(unittest.TestResult):
    """Keeps every test's outcome, with the time it took."""

    def __init__(self):
        super().__init__()
        self.results = []
        self._started = 0.0

    def startTest(self, test):
        super().startTest(test)
        self._started = time.monotonic()

    def _add(self, test, outcome, detail=None):
        entry = {
            "id": test.id(),
            "outcome": outcome,
            "seconds": round(time.monotonic() - self._started, 3),
        }
        if detail:
            entry["detail"] = detail
        self.results.append(entry)

    def addSuccess(self, test):
        super().addSuccess(test)
        self._add(test, "passed")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._add(test, "failed", self._exc_info_to_string(err, test)[-2000:])

    def addError(self, test, err):
        super().addError(test, err)
        self._add(test, "error", self._exc_info_to_string(err, test)[-2000:])

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self._add(test, "skipped", reason)

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self._add(test, "expected-failure")

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self._add(test, "unexpected-success")


def run_suite(name):
    started = time.monotonic()
    try:
        suite = unittest.defaultTestLoader.loadTestsFromName(name)
    except Exception:
        return {"name": name, "loadError": traceback.format_exc()[-2000:], "tests": []}
    recorder = Recorder()
    suite.run(recorder)
    # Close documents a test left open, so the next suite starts clean.
    for doc in list(FreeCAD.listDocuments()):
        try:
            FreeCAD.closeDocument(doc)
        except Exception:
            pass
    return {
        "name": name,
        "seconds": round(time.monotonic() - started, 1),
        "tests": recorder.results,
    }


def main():
    suites = [s for s in os.environ.get("TRIAGE_TEST_SUITES", "").split(",") if s]
    output = os.environ["TRIAGE_TEST_OUTPUT"]
    present = install_placeholders()
    report = {
        "freecad": ".".join(FreeCAD.Version()[:3]),
        "python": sys.version.split()[0],
        "placeholders": sorted(set(ABSENT) - set(present)),
        "suites": [run_suite(name) for name in suites],
    }
    try:
        import Part

        report["occt"] = Part.OCC_VERSION
    except Exception:
        pass
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=1)


try:
    main()
    code = 0
except BaseException:
    traceback.print_exc()
    code = 3
sys.stdout.flush()
sys.exit(code)
