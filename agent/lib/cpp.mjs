/**
 * QBot C++ execution-kernel bridge.
 *
 * One resolver/runner shared by the C++ tool plugin, the desk risk gate, and
 * the Dream-RSI replay. On Linux the compiled ELF runs natively; on Windows a
 * native qbot_cpp.exe is used when present, otherwise the same ELF runs inside
 * WSL (the only backend available when no Windows toolchain exists).
 *
 * Resolution order (config values win, then the matching environment override):
 *   1. explicit cppBinPath / binPath (or QBOT_CPP_BIN) that exists
 *   2. bundle-relative native kernel: <bundle>/../cpp/qbot_cpp.exe, then
 *      <bundle>/cpp/qbot_cpp(.exe)
 *   3. win32 only: WSL backend (cppWslBinPath / QBOT_CPP_WSL_BIN, else the
 *      Linux path of the checkout recorded by the owning profile manifest)
 *   4. a clear, actionable "kernel not found" error
 *
 * Nothing here throws at import time: a missing kernel only fails the tool
 * call that needs it, never the plugin load.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = dirname(fileURLToPath(import.meta.url))
const BUNDLE_DIR = resolve(LIB_DIR, '..')
const PROFILE_DIR = resolve(BUNDLE_DIR, '..', '..', '..')

let distroCache
const wslPathCache = new Map()

/** Normalize the config shapes callers pass into one set of fields. */
function fieldsOf(cpp) {
  if (typeof cpp === 'string') return { binPath: cpp, wslDistro: '', wslBinPath: '' }
  return {
    binPath: String(cpp?.cppBinPath ?? cpp?.binPath ?? ''),
    wslDistro: String(cpp?.cppWslDistro ?? ''),
    wslBinPath: String(cpp?.cppWslBinPath ?? ''),
  }
}

function firstExisting(paths) {
  for (const path of paths) {
    if (existsSync(path)) return path
  }
  return undefined
}

/** Native kernel paths beside or inside the installed bundle. */
function nativeCandidates() {
  const names = process.platform === 'win32' ? ['qbot_cpp.exe'] : ['qbot_cpp']
  return [
    ...names.map(name => resolve(BUNDLE_DIR, '..', 'cpp', name)),
    ...names.map(name => resolve(BUNDLE_DIR, 'cpp', name)),
  ]
}

/**
 * Checkout directory the owning profile installed this bundle from.
 *
 * pnpm keeps the `file:`/`link:` spec in the profile manifest, so a
 * hard-linked desktop install can still find the source checkout (and the
 * Linux ELF inside it) instead of guessing a machine-specific path.
 */
function sourceBundleDir() {
  try {
    const manifest = JSON.parse(readFileSync(resolve(PROFILE_DIR, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
    const spec = manifest?.dependencies?.['@qbot/dsh-agent']
    if (typeof spec !== 'string' || spec === '') return undefined
    return resolve(PROFILE_DIR, spec.replace(/^(file:|link:)/, ''))
  } catch {
    return undefined
  }
}

/** Linux ELF candidates, including the source checkout recorded by the profile. */
function elfCandidates() {
  const dirs = [resolve(BUNDLE_DIR, '..', 'cpp'), resolve(BUNDLE_DIR, 'cpp')]
  const source = sourceBundleDir()
  if (source !== undefined) dirs.push(resolve(source, '..', 'cpp'), resolve(source, 'cpp'))
  return dirs.map(dir => resolve(dir, 'qbot_cpp'))
}

/** Decode wsl.exe output, which is UTF-16LE on some Windows builds. */
function decodeWsl(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) return buffer.subarray(2).toString('utf16le')
  const utf8 = buffer.toString('utf8')
  if (utf8.includes('\u0000')) return buffer.toString('utf16le').replaceAll('\u0000', '')
  return utf8
}

/** Installed WSL distros, cached; empty when WSL is unavailable. */
function wslDistros() {
  if (distroCache !== undefined) return distroCache
  try {
    const result = spawnSync('wsl.exe', ['-l', '-q'], { timeout: 8000, windowsHide: true })
    distroCache = result.error === undefined && result.status === 0 && Buffer.isBuffer(result.stdout)
      ? decodeWsl(result.stdout).split(/\r?\n/).map(line => line.replaceAll('\u0000', '').trim()).filter(line => line !== '')
      : []
  } catch {
    distroCache = []
  }
  return distroCache
}

/** First installed distro unless config/env pins one. */
function wslDistro(preferred) {
  if (preferred !== '') return preferred
  return wslDistros()[0]
}

/** Windows path -> WSL path for one distro, cached; falls back to the standard /mnt/<drive> layout. */
function wslPath(winPath, distro) {
  const key = `${distro}\u0000${resolve(winPath)}`
  if (wslPathCache.has(key)) return wslPathCache.get(key)
  let value
  try {
    const result = spawnSync('wsl.exe', ['-d', distro, '--', 'wslpath', '-u', resolve(winPath).replaceAll('\\', '/')], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    if (result.error === undefined && result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim() !== '') value = result.stdout.trim()
  } catch {}
  if (value === undefined) {
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(resolve(winPath))
    if (match !== null) value = `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`
  }
  wslPathCache.set(key, value)
  return value
}

function nativeBackend(binPath) {
  return { ok: true, backend: 'native', command: binPath, args: [], binPath }
}

function wslBackend(distro, linuxPath, sourcePath) {
  return {
    ok: true,
    backend: 'wsl',
    command: 'wsl.exe',
    args: ['-d', distro, '--', linuxPath],
    binPath: linuxPath,
    distro,
    ...(sourcePath === undefined ? {} : { sourcePath }),
  }
}

function missingError(configured) {
  const prefix = configured === '' ? '' : `configured cppBinPath "${configured}" does not exist; `
  if (process.platform === 'win32') {
    return `${prefix}no C++ kernel found. Install WSL (wsl --install) and build the Linux ELF, or build a Windows qbot_cpp.exe. Override with cppBinPath / QBOT_CPP_BIN (native) or cppWslBinPath / QBOT_CPP_WSL_BIN (WSL).`
  }
  return `${prefix}no C++ kernel found. Build it with qbot-dsh/cpp: make, or set cppBinPath / QBOT_CPP_BIN.`
}

/**
 * Resolve the backend for one call without touching process state.
 * @param cpp - qbot-core/qbot-cpp config, or a bare binPath string.
 * @returns `{ ok: true, backend, command, args, binPath, distro? }` or `{ ok: false, backend: 'missing', error }`.
 */
export function resolveCpp(cpp = {}) {
  const { binPath, wslDistro: distroConfig, wslBinPath } = fieldsOf(cpp)
  const explicit = binPath !== '' ? binPath : String(process.env.QBOT_CPP_BIN ?? '')
  if (explicit !== '' && existsSync(explicit)) return nativeBackend(explicit)

  const native = firstExisting(nativeCandidates())
  if (native !== undefined) return nativeBackend(native)

  if (process.platform === 'win32') {
    const distro = wslDistro(distroConfig !== '' ? distroConfig : String(process.env.QBOT_CPP_WSL_DISTRO ?? ''))
    if (distro === undefined) return { ok: false, backend: 'missing', error: missingError(explicit) }
    const preferred = wslBinPath !== '' ? wslBinPath : String(process.env.QBOT_CPP_WSL_BIN ?? '')
    if (preferred !== '') return wslBackend(distro, preferred)
    const elf = firstExisting(elfCandidates())
    if (elf !== undefined) {
      const linuxPath = wslPath(elf, distro)
      if (linuxPath !== undefined) return wslBackend(distro, linuxPath, elf)
    }
    return {
      ok: false,
      backend: 'missing',
      error: `${missingError(explicit)} WSL distro "${distro}" is available but no Linux qbot_cpp was found; point cppWslBinPath / QBOT_CPP_WSL_BIN at the ELF (for example /mnt/d/.../qbot-dsh/cpp/qbot_cpp).`,
    }
  }

  return { ok: false, backend: 'missing', error: missingError(explicit) }
}

/** Serializable backend summary for `cpp_engine_status`. */
export function cppStatus(cpp = {}) {
  const backend = resolveCpp(cpp)
  if (!backend.ok) return { ok: false, backend: 'missing', error: backend.error }
  return {
    ok: true,
    backend: backend.backend,
    binary: backend.binPath,
    ...(backend.distro === undefined ? {} : { distro: backend.distro }),
    ...(backend.sourcePath === undefined ? {} : { source: backend.sourcePath }),
  }
}

/**
 * Run the kernel once, keeping the JSON-on-stdin contract identical across backends.
 * @param cpp - qbot-core/qbot-cpp config, or a bare binPath string.
 * @param args - kernel flags, e.g. `['--risk-check']`.
 * @param input - stdin text; omitted for `--version`.
 * @param timeoutMs - wall-clock bound; the child is killed on expiry.
 * @param label - human label used in error messages.
 * @returns `{ stdout, stderr, backend, binPath, distro? }`.
 */
export function runCpp(cpp, args, input, timeoutMs = 10000, label = 'C++ kernel') {
  const backend = resolveCpp(cpp)
  if (!backend.ok) return Promise.reject(new Error(backend.error))
  return new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawn(backend.command, [...backend.args, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      reject(new Error(`${label} could not start (${backend.backend}: ${backend.binPath}): ${error.message}`))
      return
    }
    const where = backend.backend === 'wsl' ? `${backend.distro}:${backend.binPath}` : backend.binPath
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      try { child.kill('SIGTERM') } catch {}
      reject(new Error(`${label} timed out after ${timeoutMs}ms (${where})`))
    }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`${label} could not start (${where}): ${error.message}`))
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolvePromise({
          stdout,
          stderr,
          backend: backend.backend,
          binPath: backend.binPath,
          ...(backend.distro === undefined ? {} : { distro: backend.distro }),
        })
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `${label} exited with ${code} (${where})`))
      }
    })
    child.stdin.end(input === undefined ? undefined : String(input))
  })
}