# WebAssembly / AArch64 Toolkit

Browser-based tools for Wasm inspection (including uploaded WAST memory layout), AArch64 assembly/disassembly, and 32-bit base conversion.

## Quick start

From the project root on Ubuntu 24.04+ / Debian 13+:

```sh
bash install_dependencies.sh
node server.mjs
```

Open <http://127.0.0.1:1818/wasm_interpreter.html>. Stop with Ctrl+C.

```sh
# Check dependencies only (no installation or administrator privileges)
bash install_dependencies.sh --check

# Use a different port
PORT=8081 node server.mjs
```

## Dependencies

| Requirement | Ubuntu/Debian package |
| --- | --- |
| Bash | `bash` |
| Node.js >= 18.17 (maintained LTS recommended) | `nodejs` |
| WABT: `wast2json`, `wasm-objdump` | `wabt` |
| LLVM with AArch64: `llvm-mc` | `llvm` |
| AArch64 binutils: `aarch64-linux-gnu-objdump` | `binutils-aarch64-linux-gnu` |
| Modern browser | Chrome / Edge / Firefox |

Keep all commands on PATH. No npm packages, Python, QEMU, or ARM64 hardware required.

- The installer adds only missing packages via apt; no full upgrade, third-party repositories, or PATH changes.
- Installation requires network access and administrator privileges. Non-root users need `sudo -A` with askpass configured (`SUDO_ASKPASS`), or an administrator can run the script as root. Never store passwords in scripts.
- On older distributions, install Node.js >= 18.17 from a trusted source. On other operating systems, install dependencies manually.

## Usage examples

| Tool / button | Sample input | Result |
| --- | --- | --- |
| **wast2json** | `Chapter02/local.wast` | `.json` and numbered `.wasm` files |
| **wasm-objdump** | Select a module or enter a Wasm path/URL | Disassembly and details (`-d -x`) |
| **assembler** | `sub sp, sp, #0x10` | `0xD10043FFU`; bytes `FF 43 00 D1` |
| **disassembler** | `0xD10043FFU` | AArch64 disassembly; bytes `FF 43 00 D1` |
| **AArch64 Binary to Hex** → **translate** | `1101 0001 0000 0000 0100 0011 1111 1111` | `0xD10043FF` |
| **reset** | Any bit values | All bits cleared; `0x00000000` |
| **Base Converter** → **convert** | Hex field: `0xD10043FF` | Decimal `3506455551`; binary `1101 0001 0000 0000 0100 0011 1111 1111` |
| **Base Converter** → **convert** | Decimal field: `16`, or binary field: `0001 0000` | Hex `0x00000010`; decimal `16`; binary `0000 0000 0000 0000 0000 0000 0001 0000` |
| **Base Converter** → **reset** | Any values in Hex/Decimal/Binary | Hex `0x00000000`; decimal `0`; binary `0000 0000 0000 0000 0000 0000 0000 0000` |
| **WAST Memory Layout Explorer** | Upload `layout.wast`, choose module, inspect | If linear memory exists: shows memory bytes + data-segment highlight. If not: shows module byte layout + section highlight |

### Wasm workflow

```text
WAST path/URL → wast2json → select module → wasm-objdump
Wasm path/URL ───────────────────────────→ wasm-objdump
Upload WAST/WAT/WASM ───────────────────→ memory layout explorer
```

### Memory layout explorer workflow

- In section 7, selecting a file does not load content immediately; click **upload** to load it.
- Click **reset** to clear section 7 file state, module options, memory view, and jump state.
- Running **wast2json** in section 1 now auto-loads the same source file into section 7 by default.

Absolute paths, project-relative paths, and HTTP(S) URLs are supported, including multi-module WAST.
Local conversion may overwrite outputs beside the source; remote files use temporary storage cleaned up on normal exit.

### AArch64 tips

- **assembler:** one instruction only; no pseudo-instructions or unresolved symbols.
- **Binary to Hex:** enter one `0` or `1` per field, ordered bit 31 to bit 0. Output is an instruction value, not little-endian bytes.
- For a few set bits: **reset** → edit bits → **translate**. Re-translate after edits; empty or invalid fields are flagged.
- **Base Converter:** edit any of the three fields, then click **convert** to update all three using the last edited field. Unsigned 32-bit range: `0–4294967295`; invalid or overflowing values show an error.
- **Base Converter reset:** click **reset** to clear validation and set Hex/Decimal/Binary back to `0`.
- Hex accepts an optional `0x` prefix and displays `0x` + eight uppercase digits. Binary accepts spaces and displays 32 bits in four-bit groups.
- **Binary to Hex** and **Base Converter** also work offline via `file://`; other tools require the server.

## Safety and limits

Local use only (`127.0.0.1`, Host/same-origin checks, no CORS). The server reads and writes local files:
**do not expose it publicly or process untrusted modules.**

Limits: 16 MiB source files, 15 s downloads, 30 s commands, 4 MiB command output.
Errors appear in each tool's output area.

## Tests

```sh
node --test server.test.mjs install_dependencies.test.mjs
```

Uses temporary files and mocked installation commands; leaves chapter examples unchanged and never runs real apt/sudo.
