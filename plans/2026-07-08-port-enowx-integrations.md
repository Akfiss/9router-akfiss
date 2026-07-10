# Plan: Port enowx Integrations → 9router-akfiss CLI Tools

> **Status**: PROPOSED — awaiting user approval
> **Date**: 2026-07-08
> **Author**: Analysis from session context

---

## TL;DR

9router-akfiss **SUDAH PUNYA** fitur CLI Tools yang fungsional — bahkan lebih lengkap dari enowx Integrations (15 tools vs 8). Yang TIDAK ADA di 9router tapi ADA di enowx ada 3 hal:

1. **Snippet generator** — copy-paste config content (untuk tool yang tidak bisa auto-write, atau untuk remote setup)
2. **Atomic file writes** — write via temp file + rename (saat ini 9router pakai `fs.writeFile` langsung, ada risiko corrupt kalau power loss di tengah write)
3. **File permission enforcement** — `0600` untuk file yang menyimpan API key (saat ini 9router tidak set permission apapun)

**Rekomendasi**: JANGAN port seluruh Integrations feature — 9router sudah lebih lengkap. Fokus pada 3 gap di atas sebagai **enhancement** ke sistem yang sudah ada.

---

## Current State Analysis

### 9router-akfiss (EXISTING — more complete)

| Feature | Status | Details |
|---------|--------|---------|
| CLI Tools registry | ✅ 15 tools | `src/shared/constants/cliTools.js` |
| Per-tool config writer (POST) | ✅ | `src/app/api/cli-tools/{tool}-settings/route.js` |
| Per-tool config reader (GET) | ✅ | Same route, checks installed + has9Router |
| Per-tool config remover (DELETE) | ✅ | Same route, surgical removal |
| Batch status endpoint | ✅ | `/api/cli-tools/all-statuses` |
| Dashboard UI — tool grid | ✅ | `src/app/(dashboard)/dashboard/cli-tools/` |
| Dashboard UI — per-tool detail | ✅ | `[toolId]/ToolDetailClient.js` |
| Per-tool card components | ✅ | `components/{Tool}ToolCard.js` |
| MITM tools (Antigravity, Copilot, Kiro) | ✅ | enowx TIDAK PUNYA ini |
| Guide-type tools (Cursor, Roo, Continue, Amp, Qwen) | ✅ | enowx TIDAK PUNYA ini |
| Multi-model support | ✅ | OpenCode, Droid, OpenClaw |
| Subagent model config | ✅ | OpenCode (agent.explorer) |
| Per-agent model override | ✅ | OpenClaw |
| Merge strategy (preserve unrelated keys) | ✅ | All tools |
| JSONC parsing (trailing commas) | ✅ | OpenCode |
| TOML parsing | ✅ | Codex, DeepSeek TUI |
| YAML parsing | ✅ | Hermes |
| Auto-create API key if none | ✅ | Via dashboard key management |

**Tools di 9router (15)**: Claude, Codex, OpenCode, Cline, Kilo, Droid, OpenClaw, Hermes, Cowork, DeepSeek TUI, jcode + Guide-type: Cursor, Roo, Continue, Amp, Qwen + MITM: Antigravity, Copilot, Kiro

### enowx (SOURCE — has 3 unique features)

| Feature | Status | Details |
|---------|--------|---------|
| Tool registry | ✅ 8 tools | Hardcoded in `integrations.go` |
| Per-tool apply (write) | ✅ | `tools.go` — applyClaude, applyCodex, etc. |
| Per-tool reset (remove) | ✅ | `tools.go` — resetClaude, resetCodex, etc. |
| Per-tool status (read-back) | ✅ | `apply.go` — toolConnected() |
| Batch status | ✅ | `StatusOf()` |
| API endpoints (5) | ✅ | List, Info, Apply, Reset, Snippet |
| UI — tool grid + connect modal | ✅ | `IntegrationsApp.tsx` |
| **Snippet generator** | ✅ | `snippet.go` — generate copy-paste config |
| **Atomic file writes** | ✅ | `fileio.go` — writeAtomic (temp+rename) |
| **File permissions (0600)** | ✅ | `fileio.go` — credentials get 0600 |
| Tunnel-aware base URL | ✅ | Handler resolves tunnel vs localhost |

**Tools di enowx (8)**: Claude, Codex, OpenCode, Cline, Kilo, Droid, OpenClaw, Hermes

---

## Gap Analysis: enowx features missing from 9router

### Gap 1: Snippet Generator (MEDIUM priority)

**enowx**: `POST /api/integrations/{tool}/snippet` menghasilkan config content sebagai text untuk copy-paste. Dipakai untuk:
- Tool yang di-install di remote machine (tidak bisa auto-write)
- Tool yang user tidak mau berikan akses filesystem ke 9router
- Quick copy ke clipboard tanpa edit file

**9router**: TIDAK ADA. Untuk guide-type tools (Cursor, Roo, Continue, Amp, Qwen) 9router sudah punya `codeBlock` statis di `cliTools.js` dengan template `{{baseUrl}}`/`{{apiKey}}`/`{{model}}` yang di-render di UI. Tapi untuk custom-type tools (Claude, Codex, OpenCode, Cline, Kilo, Droid, OpenClaw, Hermes, DeepSeek TUI, jcode), tidak ada snippet generator.

### Gap 2: Atomic File Writes (HIGH priority — safety)

**enowx**: `writeAtomic(path, content)` di `fileio.go`:
1. Write ke temp file (e.g. `opencode.json.tmp`)
2. `os.Rename(tempFile, finalFile)` — atomic on same filesystem
3. Jika crash di tengah, file asli tetap utuh

**9router**: Semua CLI tools route pakai `await fs.writeFile(path, content)` langsung. Jika process crash / power loss tepat saat write, file bisa corrupt (partial write). Karena file-file ini menyimpan API keys dan config penting, corrupt = tool tidak bisa start.

### Gap 3: File Permissions (MEDIUM priority — security)

**enowx**: File yang menyimpan credentials di-set `0600` (owner read/write only). Contoh: `~/.codex/auth.json`, `~/.cline/data/secrets.json`.

**9router**: Tidak ada `chmod`/permission set. File dibuat dengan default umask (biasanya `0644` di Linux/macOS), artinya user lain di system bisa baca API key.

---

## Proposed Implementation

### Phase 1: Atomic File Writes (HIGH — do first)

**Files to modify**: Semua `src/app/api/cli-tools/{tool}-settings/route.js` (15 files)

**Approach**: Buat shared utility, lalu replace semua `fs.writeFile` calls.

#### New file: `src/lib/utils/atomicWrite.js`
```javascript
import fs from "fs/promises";
import path from "path";

/**
 * Write file atomically by writing to a temp file then renaming.
 * Prevents config corruption if process crashes during write.
 * 
 * @param {string} filePath - Final file path
 * @param {string} content - Content to write
 * @param {{ mode?: number }} [options] - File mode (e.g. 0o600 for credentials)
 */
export async function atomicWriteFile(filePath, content, options = {}) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  
  const tempPath = filePath + ".tmp-" + process.pid;
  await fs.writeFile(tempPath, content, "utf-8");
  
  if (options.mode !== undefined) {
    await fs.chmod(tempPath, options.mode);
  }
  
  await fs.rename(tempPath, filePath);
}
```

#### Changes per route file
```diff
- await fs.writeFile(configPath, JSON.stringify(config, null, 2));
+ await atomicWriteFile(configPath, JSON.stringify(config, null, 2));
```

For credential files (auth.json, secrets.json):
```diff
- await fs.writeFile(authPath, JSON.stringify(auth, null, 2));
+ await atomicWriteFile(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
```

**Files affected** (all CLI tool routes):
- `claude-settings/route.js` — `~/.claude/settings.json` → atomic
- `codex-settings/route.js` — `~/.codex/config.toml` (atomic), `~/.codex/auth.json` (atomic + 0600)
- `opencode-settings/route.js` — `~/.config/opencode/opencode.json` → atomic
- `cline-settings/route.js` — `~/.cline/data/globalState.json` (atomic), `~/.cline/data/secrets.json` (atomic + 0600)
- `kilo-settings/route.js` — `~/.local/share/kilo/auth.json` → atomic + 0600
- `openclaw-settings/route.js` — `~/.openclaw/openclaw.json` → atomic
- `hermes-settings/route.js` — `~/.hermes/config.yaml` (atomic), `~/.hermes/.env` (atomic + 0600)
- `droid-settings/route.js` — `~/.factory/settings.json` → atomic
- `cowork-settings/route.js` — atomic
- `deepseek-tui-settings/route.js` — `~/.deepseek/config.toml` → atomic
- `jcode-settings/route.js` — atomic

**Verification**: After change, test apply+reset for each tool. Check that temp files don't linger. Test kill process during write (should leave original intact).

---

### Phase 2: Snippet Generator (MEDIUM — nice to have)

**New API endpoint**: `POST /api/cli-tools/{tool}/snippet`

**New file**: `src/app/api/cli-tools/[tool]/snippet/route.js`

```javascript
// POST /api/cli-tools/{tool}/snippet
// Body: { baseUrl, apiKey, model, models? }
// Returns: { language, content, filename }
```

Logic:
1. Match `tool` against `CLI_TOOLS` registry
2. For each tool, generate the same config content that would be written to disk
3. Return as `{ language: "json"|"toml"|"yaml"|"bash", content: "...", filename: "..." }`
4. UI shows copy button + download button

**New UI component**: Snippet tab in each tool's detail page

**Snippet generators per tool** (extract from existing POST handlers):
- Claude → JSON snippet for `settings.json`
- Codex → TOML snippet for `config.toml` + JSON for `auth.json`
- OpenCode → JSON snippet for `opencode.json`
- Cline → JSON for `globalState.json` + `secrets.json`
- etc.

**Approach**: Refactor existing POST handlers to extract config-building logic into pure functions, then call them from both POST (write to disk) and snippet (return as text).

#### New file: `src/lib/cli-tools/snippets.js`
```javascript
export function buildClaudeConfig({ baseUrl, apiKey, model, models }) { ... }
export function buildCodexConfig({ baseUrl, apiKey, model }) { ... }
export function buildOpenCodeConfig({ baseUrl, apiKey, model, models, activeModel }) { ... }
// ... one per tool
```

Each returns `{ files: [{ path, content, language, isCredential }], summary }`.

**Files affected**:
- NEW: `src/lib/cli-tools/snippets.js` — config builders
- NEW: `src/app/api/cli-tools/[tool]/snippet/route.js` — API endpoint
- MODIFY: All `src/app/api/cli-tools/{tool}-settings/route.js` — use shared builders
- MODIFY: `src/app/(dashboard)/dashboard/cli-tools/[toolId]/ToolDetailClient.js` — add "Copy Config" tab
- NEW: `src/app/(dashboard)/dashboard/cli-tools/components/SnippetViewer.js`

---

### Phase 3: File Permissions (MEDIUM — do with Phase 1)

Already covered in Phase 1's `atomicWriteFile` with `{ mode: 0o600 }` option for credential files.

**Files that should get 0600**:
- Codex: `~/.codex/auth.json`
- Cline: `~/.cline/data/secrets.json`
- Kilo: `~/.local/share/kilo/auth.json`
- Hermes: `~/.hermes/.env`
- Any other file containing API keys

Note: Windows ignores Unix permissions. This only matters on Linux/macOS. On Windows, `0600` is a no-op but harmless.

---

## What NOT to Port

| enowx Feature | Reason to Skip |
|---------------|----------------|
| Tool registry (specs array) | 9router's `CLI_TOOLS` is already richer (15 vs 8) |
| Per-tool apply/reset functions | 9router already has these per-tool route.js |
| Batch status endpoint | 9router already has `/api/cli-tools/all-statuses` |
| ConnectModal UI | 9router already has per-tool detail page with better UX |
| Tunnel-aware base URL | 9router already resolves base URL client-side (tunnel > cloud > localhost) |
| Auto-create API key | 9router already has API key management dashboard |

---

## Implementation Order

```
Phase 1+3: Atomic writes + file permissions    [2-3 hours]
  ↓
Phase 2: Snippet generator                      [3-4 hours]
  ↓
Testing + verification                           [1-2 hours]
```

**Total estimate**: 6-9 hours

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Atomic write breaks on Windows (rename across volumes) | LOW | `fs.rename` on same dir is atomic on all platforms; temp file in same dir |
| Snippet generator produces wrong config | MEDIUM | Reuse existing POST handler logic (extract, don't rewrite) |
| Refactoring POST handlers introduces bugs | MEDIUM | Keep extracted functions pure; test against existing behavior |
| 0600 mode fails on Windows | NONE | `fs.chmod` is no-op on Windows, harmless |

---

## Testing Plan

### Phase 1 (Atomic writes)
1. For each tool: apply config → verify file content correct → verify no .tmp files remain
2. Simulate crash: write large config, kill process mid-write → verify original file intact
3. Verify 0600 on credential files (Linux/macOS): `ls -la ~/.codex/auth.json` → `-rw-------`

### Phase 2 (Snippets)
1. For each tool: generate snippet → copy to fresh config file → tool reads it correctly
2. Verify snippet matches what POST writes (diff)
3. UI: snippet tab renders, copy works, download works

---

## Files Summary

### New files
- `src/lib/utils/atomicWrite.js` — atomic write utility
- `src/lib/cli-tools/snippets.js` — config builders (Phase 2)
- `src/app/api/cli-tools/[tool]/snippet/route.js` — snippet API (Phase 2)
- `src/app/(dashboard)/dashboard/cli-tools/components/SnippetViewer.js` — snippet UI (Phase 2)

### Modified files
- All 15 `src/app/api/cli-tools/{tool}-settings/route.js` — use `atomicWriteFile`
- `src/app/(dashboard)/dashboard/cli-tools/[toolId]/ToolDetailClient.js` — add snippet tab (Phase 2)

---

## Open Questions

1. **Apakah perlu snippet generator?** 9router sudah punya `codeBlock` statis untuk guide-type tools. Snippet generator hanya menambah value untuk custom-type tools (Claude, Codex, OpenCode, dll). Worth doing atau tidak?
2. **Priority**: Phase 1 (atomic writes) jelas worth it untuk safety. Phase 2 (snippets) nice-to-have. Mau keduanya atau hanya Phase 1?
