import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { Plugin } from "@opencode-ai/plugin"

// ── Config types ──────────────────────────────────────────────────────────────

interface CommandConfig {
  /** Required. The shell command to execute. */
  command: string
  /** Optional working directory for the command. */
  cwd?: string
  /** Optional extra environment variables for the command. */
  env?: Record<string, string>
  /** Optional timeout in milliseconds. */
  timeout?: number
}

type CommandEntry = string | CommandConfig

/**
 * Configuration is a map of event patterns to arrays of commands.
 *
 * Event patterns can be:
 *   - An exact event type:  "session.idle"
 *   - A namespace wildcard: "session.*"
 *   - A catch-all:          "*"
 */
interface PluginConfig {
  [eventPattern: string]: CommandEntry[]
}

// ── Event pattern matching ────────────────────────────────────────────────────

/**
 * Check whether an event type matches a pattern.
 *
 * - "*"           matches everything
 * - "session.*"   matches any event starting with "session."
 * - "session.idle" matches only "session.idle"
 */
export function matchEvent(pattern: string, eventType: string): boolean {
  if (pattern === "*") return true
  if (pattern.endsWith(".*")) {
    const namespace = pattern.slice(0, -2)
    return eventType.startsWith(namespace + ".")
  }
  return pattern === eventType
}

// ── Variable / event-data substitution ────────────────────────────────────────

/**
 * Resolve a dot-notation path against an object.
 * Returns the value at the path, or `undefined` if any segment is missing.
 *
 * Example: resolveEventPath({ type: "session.idle", properties: { id: "abc" } }, "properties.id")
 *          => "abc"
 */
export function resolveEventPath(obj: unknown, path: string): unknown {
  let current: unknown = obj
  for (const segment of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * Recursively walk any JSON-parsed value and replace:
 *   - `{env:VAR_NAME}` with `process.env[VAR_NAME]` (empty string if unset)
 *   - `{event.path.to.field}` with the resolved value from the event object
 *
 * Unset variables / missing paths are replaced with an empty string,
 * matching OpenCode's own behaviour for `{env:...}` in opencode.json.
 */
export function interpolate<T>(value: T, eventData?: unknown): T {
  if (typeof value === "string") {
    return value.replace(/\{([^}]+)\}/g, (original, token: string) => {
      // {env:VAR_NAME}
      if (token.startsWith("env:")) {
        const varName = token.slice(4)
        return process.env[varName] ?? ""
      }
      // {event.type}, {event.properties.xxx}, etc.
      if (token.startsWith("event.") && eventData !== undefined) {
        const path = token.slice(6) // strip "event."
        const resolved = resolveEventPath(eventData, path)
        return resolved !== undefined ? String(resolved) : ""
      }
      // {event} by itself — stringify the entire event
      if (token === "event" && eventData !== undefined) {
        return JSON.stringify(eventData)
      }
      // Unknown token — leave as-is
      return original
    }) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolate(item, eventData)) as unknown as T
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = interpolate(v, eventData)
    }
    return result as unknown as T
  }
  return value
}

// ── Config loading ────────────────────────────────────────────────────────────

/**
 * Read and parse a single opencode-event-shell-exec.json file.
 * Returns `null` when the file does not exist.
 * Returns `{}` (empty config) on any other error or malformed content.
 */
export function readConfigFile(filePath: string): PluginConfig | null {
  try {
    const raw = readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(raw)

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(
        `[opencode-event-shell-exec] ${filePath} must be a JSON object — skipping`,
      )
      return {}
    }

    // Validate that every value is an array
    for (const [key, val] of Object.entries(parsed)) {
      if (!Array.isArray(val)) {
        console.warn(
          `[opencode-event-shell-exec] ${filePath}: value for "${key}" must be an array — skipping key`,
        )
        delete parsed[key]
      }
    }

    return parsed as PluginConfig
  } catch (err: unknown) {
    const isNotFound =
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    if (!isNotFound) {
      console.warn(
        `[opencode-event-shell-exec] Could not read ${filePath}: ${String(err)}`,
      )
    }
    return null
  }
}

/**
 * Load and merge plugin configuration from all supported locations.
 *
 * Config is read from two places (mirroring OpenCode's own precedence model):
 *   1. Global:  ~/.config/opencode/opencode-event-shell-exec.json
 *   2. Project: <directory>/opencode-event-shell-exec.json
 *
 * Both files are optional. When both exist, command arrays for the same
 * event pattern are concatenated (global first, then project).
 * This follows OpenCode's "merge, not replace" convention.
 *
 * Environment variable interpolation ({env:VAR}) is applied at config-load
 * time. Event-data interpolation ({event.*}) is applied at execution time.
 */
export function loadConfig(directory?: string): PluginConfig {
  const globalPath = join(
    homedir(),
    ".config",
    "opencode",
    "opencode-event-shell-exec.json",
  )
  const globalConfig = readConfigFile(globalPath)

  const projectPath = directory
    ? join(directory, "opencode-event-shell-exec.json")
    : null
  const projectConfig = projectPath ? readConfigFile(projectPath) : null

  const merged: PluginConfig = {}

  // Merge global config
  if (globalConfig) {
    for (const [pattern, commands] of Object.entries(globalConfig)) {
      merged[pattern] = [...(merged[pattern] ?? []), ...commands]
    }
  }

  // Merge project config (appended after global)
  if (projectConfig) {
    for (const [pattern, commands] of Object.entries(projectConfig)) {
      merged[pattern] = [...(merged[pattern] ?? []), ...commands]
    }
  }

  // Apply {env:...} interpolation to the merged config
  return interpolate(merged)
}

// ── Command execution ─────────────────────────────────────────────────────────

/**
 * Normalise a CommandEntry into a CommandConfig object.
 */
function normaliseCommand(entry: CommandEntry): CommandConfig {
  if (typeof entry === "string") {
    return { command: entry }
  }
  return entry
}

/**
 * Execute an array of commands sequentially using Bun's $ shell API.
 *
 * Each command runs with .nothrow().quiet() so that failures are captured
 * rather than thrown. Non-zero exit codes are logged as warnings.
 *
 * Event-data interpolation ({event.*}) is applied to command strings at
 * execution time, so each invocation gets the current event's data.
 */
export async function executeCommands(
  $: Parameters<NonNullable<Plugin>>[0]["$"],
  commands: CommandEntry[],
  event: unknown,
  log: (msg: string, extra?: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  for (const entry of commands) {
    const config = normaliseCommand(entry)
    // Interpolate event data into the command string
    const cmd = interpolate(config.command, event)

    try {
      // Build the shell command using Bun's $ tagged template
      // We use { raw: cmd } to pass the already-interpolated string directly
      let shell = $`${{ raw: cmd }}`.nothrow().quiet()

      if (config.cwd) {
        shell = shell.cwd(config.cwd)
      }

      if (config.env) {
        const env: Record<string, string> = {}
        for (const [k, v] of Object.entries(process.env)) {
          if (v !== undefined) env[k] = v
        }
        Object.assign(env, config.env)
        shell = shell.env(env)
      }

      let result: { exitCode: number; stdout: Buffer; stderr: Buffer }

      if (config.timeout) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`Command timed out after ${config.timeout}ms`)),
            config.timeout,
          )
        })
        result = await Promise.race([shell, timeoutPromise])
      } else {
        result = await shell
      }

      if (result.exitCode !== 0) {
        await log(
          `Command exited with code ${result.exitCode}: ${cmd}`,
          {
            command: cmd,
            exitCode: result.exitCode,
            stderr: result.stderr.toString().slice(0, 500),
          },
        )
      }
    } catch (err) {
      await log(
        `Command failed: ${cmd} — ${String(err)}`,
        { command: cmd, error: String(err) },
      )
    }
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const EventShellExecPlugin: Plugin = async ({ client, $, directory }) => {
  const config = loadConfig(directory)
  const patterns = Object.keys(config)

  if (patterns.length === 0) return {}

  async function log(message: string, extra?: Record<string, unknown>) {
    await client.app.log({
      body: {
        service: "opencode-event-shell-exec",
        level: "warn",
        message,
        extra,
      },
    })
  }

  return {
    event: async ({ event }) => {
      // Find all patterns that match this event type
      const matchingPatterns = patterns.filter((pattern) =>
        matchEvent(pattern, event.type),
      )

      if (matchingPatterns.length === 0) return

      // Run matched pattern groups in parallel, commands within each group sequentially
      await Promise.allSettled(
        matchingPatterns.map((pattern) =>
          executeCommands($, config[pattern], event, log),
        ),
      )
    },
  }
}

export default EventShellExecPlugin
