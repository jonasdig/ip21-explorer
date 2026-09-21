"""IP21 Explorer - fast trend viewer for IP21 process data."""
from importlib.metadata import PackageNotFoundError, version as _version

try:
    # Written at install time by setuptools-scm, from the git history: a
    # tagged commit is "0.1.0", any other one carries its own hash. That is
    # what lets "pip install --upgrade git+..." see a new version at all.
    __version__ = _version("ip21-explorer")
except PackageNotFoundError:  # a checkout that was never installed
    __version__ = "unknown"
