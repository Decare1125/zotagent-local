# Translation service source

Upstream: https://github.com/guaguastandup/zotero-pdf2zh
Installed server version: 4.1.7. License: AGPL-3.0-or-later (see LICENSE).
Copyright: guaguastandup and contributors.

This separate process is bundled in source form. ZotAgent supplies its own UI, queue, progress adapter and an independently managed local Python environment. No original Zotero extension is loaded. Config examples only; no user credentials or translation history are shipped. The engine adapter disables engine self-install and updates.

ZotAgent adapter changes: UTF-8 piped progress, no console, console entry point loaded through importlib.metadata to avoid launchers bound to the original environment. Engine runs with --enable_venv false, --skip_install true and --check_update false. The server and utils files are upstream source; no claim of proprietary reimplementation is made.

ZotAgent modification: a localhost cancellation endpoint coordinates with the adapter to stop the process tree for the requested task.

ZotAgent modification: retains a safe diagnostic hint for Google HTTP 429 when the translator exits without producing a PDF.
