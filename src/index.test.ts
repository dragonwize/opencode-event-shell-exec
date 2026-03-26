import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
  spyOn,
} from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { $ } from "bun"
import {
  interpolate,
  resolveEventPath,
  matchEvent,
  readConfigFile,
  loadConfig,
  executeCommands,
  EventShellExecPlugin,
} from "./index"

// ── matchEvent() ──────────────────────────────────────────────────────────────

describe("matchEvent()", () => {
  it("matches everything with '*'", () => {
    expect(matchEvent("*", "session.idle")).toBe(true)
    expect(matchEvent("*", "file.edited")).toBe(true)
    expect(matchEvent("*", "tool.execute.after")).toBe(true)
  })

  it("matches namespace wildcard 'session.*'", () => {
    expect(matchEvent("session.*", "session.idle")).toBe(true)
    expect(matchEvent("session.*", "session.created")).toBe(true)
    expect(matchEvent("session.*", "session.error")).toBe(true)
  })

  it("does not match other namespaces with namespace wildcard", () => {
    expect(matchEvent("session.*", "file.edited")).toBe(false)
    expect(matchEvent("session.*", "tool.execute.after")).toBe(false)
  })

  it("does not match the namespace itself without a dot-suffix", () => {
    expect(matchEvent("session.*", "session")).toBe(false)
  })

  it("matches exact event type", () => {
    expect(matchEvent("session.idle", "session.idle")).toBe(true)
  })

  it("does not match different exact event type", () => {
    expect(matchEvent("session.idle", "session.created")).toBe(false)
  })

  it("matches multi-level namespace wildcards", () => {
    expect(matchEvent("tool.*", "tool.execute.after")).toBe(true)
    expect(matchEvent("tool.*", "tool.use")).toBe(true)
  })
})

// ── resolveEventPath() ────────────────────────────────────────────────────────

describe("resolveEventPath()", () => {
  const event = {
    type: "session.idle",
    properties: {
      sessionId: "abc-123",
      nested: { deep: "value" },
    },
  }

  it("resolves a top-level field", () => {
    expect(resolveEventPath(event, "type")).toBe("session.idle")
  })

  it("resolves a nested field", () => {
    expect(resolveEventPath(event, "properties.sessionId")).toBe("abc-123")
  })

  it("resolves a deeply nested field", () => {
    expect(resolveEventPath(event, "properties.nested.deep")).toBe("value")
  })

  it("returns undefined for a missing field", () => {
    expect(resolveEventPath(event, "nonexistent")).toBeUndefined()
  })

  it("returns undefined for a missing nested field", () => {
    expect(resolveEventPath(event, "properties.missing.field")).toBeUndefined()
  })

  it("returns undefined when the object is null", () => {
    expect(resolveEventPath(null, "type")).toBeUndefined()
  })

  it("returns undefined when the object is undefined", () => {
    expect(resolveEventPath(undefined, "type")).toBeUndefined()
  })
})

// ── interpolate() ─────────────────────────────────────────────────────────────

describe("interpolate()", () => {
  beforeEach(() => {
    process.env.TEST_VAR = "hello"
    process.env.ANOTHER_VAR = "world"
  })

  afterEach(() => {
    delete process.env.TEST_VAR
    delete process.env.ANOTHER_VAR
  })

  it("replaces a single {env:VAR} token in a string", () => {
    expect(interpolate("{env:TEST_VAR}")).toBe("hello")
  })

  it("replaces multiple {env:...} tokens in one string", () => {
    expect(interpolate("{env:TEST_VAR} {env:ANOTHER_VAR}")).toBe("hello world")
  })

  it("replaces an unset variable with an empty string", () => {
    expect(interpolate("{env:DEFINITELY_NOT_SET_12345}")).toBe("")
  })

  it("leaves a string with no tokens unchanged", () => {
    expect(interpolate("no tokens here")).toBe("no tokens here")
  })

  it("passes numbers through unchanged", () => {
    expect(interpolate(42)).toBe(42)
  })

  it("passes booleans through unchanged", () => {
    expect(interpolate(true)).toBe(true)
    expect(interpolate(false)).toBe(false)
  })

  it("passes null through unchanged", () => {
    expect(interpolate(null)).toBeNull()
  })

  it("interpolates strings inside an array", () => {
    expect(interpolate(["{env:TEST_VAR}", "literal"])).toEqual([
      "hello",
      "literal",
    ])
  })

  it("interpolates strings inside a nested object", () => {
    const input = {
      command: "echo {env:TEST_VAR}",
      env: { KEY: "{env:ANOTHER_VAR}" },
    }
    expect(interpolate(input)).toEqual({
      command: "echo hello",
      env: { KEY: "world" },
    })
  })

  it("replaces {event.type} when event data is provided", () => {
    const event = { type: "session.idle" }
    expect(interpolate("Event: {event.type}", event)).toBe(
      "Event: session.idle",
    )
  })

  it("replaces {event.properties.xxx} with nested event data", () => {
    const event = { type: "session.idle", properties: { id: "abc" } }
    expect(interpolate("ID: {event.properties.id}", event)).toBe("ID: abc")
  })

  it("replaces {event} with JSON-stringified event", () => {
    const event = { type: "session.idle" }
    expect(interpolate("{event}", event)).toBe(
      JSON.stringify(event),
    )
  })

  it("replaces missing event paths with empty string", () => {
    const event = { type: "session.idle" }
    expect(interpolate("{event.properties.missing}", event)).toBe("")
  })

  it("leaves unknown tokens as-is", () => {
    expect(interpolate("{unknown_token}")).toBe("{unknown_token}")
  })

  it("handles mixed env and event tokens", () => {
    const event = { type: "session.idle" }
    expect(
      interpolate("cmd --type={event.type} --key={env:TEST_VAR}", event),
    ).toBe("cmd --type=session.idle --key=hello")
  })

  it("handles deeply-nested structures", () => {
    const input = {
      "session.*": [
        { command: "echo {env:TEST_VAR}" },
        "echo literal",
      ],
    }
    expect(interpolate(input)).toEqual({
      "session.*": [{ command: "echo hello" }, "echo literal"],
    })
  })
})

// ── readConfigFile() ──────────────────────────────────────────────────────────

describe("readConfigFile()", () => {
  let readFileSyncSpy: ReturnType<typeof spyOn>
  let consoleWarnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    readFileSyncSpy = spyOn(fs, "readFileSync")
    consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    readFileSyncSpy.mockRestore()
    consoleWarnSpy.mockRestore()
  })

  it("returns a parsed config when the file is valid", () => {
    const config = { "session.idle": ["echo done"] }
    readFileSyncSpy.mockReturnValue(JSON.stringify(config))

    expect(readConfigFile("/any/path.json")).toEqual(config)
  })

  it("returns null when the file does not exist (ENOENT)", () => {
    const err = Object.assign(new Error("not found"), { code: "ENOENT" })
    readFileSyncSpy.mockImplementation(() => {
      throw err
    })

    expect(readConfigFile("/missing.json")).toBeNull()
    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })

  it("returns null and warns on a non-ENOENT read error", () => {
    readFileSyncSpy.mockImplementation(() => {
      throw new Error("permission denied")
    })

    expect(readConfigFile("/bad.json")).toBeNull()
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
  })

  it("returns {} and warns when the file is not a JSON object", () => {
    readFileSyncSpy.mockReturnValue(JSON.stringify([1, 2, 3]))

    expect(readConfigFile("/array.json")).toEqual({})
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
  })

  it("returns null and warns on malformed JSON", () => {
    readFileSyncSpy.mockReturnValue("not valid json {{{")

    expect(readConfigFile("/malformed.json")).toBeNull()
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
  })

  it("strips keys whose values are not arrays and warns", () => {
    readFileSyncSpy.mockReturnValue(
      JSON.stringify({
        "session.idle": ["echo done"],
        "bad.key": "not an array",
      }),
    )

    const result = readConfigFile("/partial.json")
    expect(result).toEqual({ "session.idle": ["echo done"] })
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
  })

  it("handles config with command objects", () => {
    const config = {
      "session.idle": [
        { command: "echo done", timeout: 5000 },
        "echo simple",
      ],
    }
    readFileSyncSpy.mockReturnValue(JSON.stringify(config))

    expect(readConfigFile("/objects.json")).toEqual(config)
  })
})

// ── loadConfig() ──────────────────────────────────────────────────────────────

describe("loadConfig()", () => {
  let readFileSyncSpy: ReturnType<typeof spyOn>
  let homedirSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    homedirSpy = spyOn(os, "homedir").mockReturnValue("/home/testuser")
    readFileSyncSpy = spyOn(fs, "readFileSync")
    spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    readFileSyncSpy.mockRestore()
    homedirSpy.mockRestore()
  })

  function mockFiles(files: Record<string, string | null>) {
    readFileSyncSpy.mockImplementation((filePath: unknown) => {
      const p = filePath as string
      if (p in files) {
        const content = files[p]
        if (content === null) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
        }
        return content
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })
  }

  const globalPath = path.join(
    "/home/testuser",
    ".config",
    "opencode",
    "opencode-event-shell-exec.json",
  )

  it("merges global and project configs, global first", () => {
    mockFiles({
      [globalPath]: JSON.stringify({ "session.idle": ["echo global"] }),
      "/proj/opencode-event-shell-exec.json": JSON.stringify({
        "session.idle": ["echo project"],
      }),
    })

    expect(loadConfig("/proj")).toEqual({
      "session.idle": ["echo global", "echo project"],
    })
  })

  it("returns only project config when global is absent", () => {
    mockFiles({
      "/proj/opencode-event-shell-exec.json": JSON.stringify({
        "file.edited": ["echo edited"],
      }),
    })

    expect(loadConfig("/proj")).toEqual({ "file.edited": ["echo edited"] })
  })

  it("returns only global config when project is absent", () => {
    mockFiles({
      [globalPath]: JSON.stringify({ "*": ["echo all"] }),
    })

    expect(loadConfig("/proj")).toEqual({ "*": ["echo all"] })
  })

  it("returns {} when both files are absent", () => {
    mockFiles({})
    expect(loadConfig("/proj")).toEqual({})
  })

  it("returns {} when no directory is provided and global is absent", () => {
    mockFiles({})
    expect(loadConfig()).toEqual({})
  })

  it("returns only global config when no directory is provided", () => {
    mockFiles({
      [globalPath]: JSON.stringify({ "session.*": ["echo session"] }),
    })

    expect(loadConfig()).toEqual({ "session.*": ["echo session"] })
  })

  it("merges different keys from global and project", () => {
    mockFiles({
      [globalPath]: JSON.stringify({ "session.idle": ["echo global"] }),
      "/proj/opencode-event-shell-exec.json": JSON.stringify({
        "file.edited": ["echo project"],
      }),
    })

    expect(loadConfig("/proj")).toEqual({
      "session.idle": ["echo global"],
      "file.edited": ["echo project"],
    })
  })

  it("applies {env:...} interpolation to the merged config", () => {
    process.env.SHELL_CMD = "notify-send done"
    mockFiles({
      "/proj/opencode-event-shell-exec.json": JSON.stringify({
        "session.idle": ["{env:SHELL_CMD}"],
      }),
    })

    expect(loadConfig("/proj")).toEqual({
      "session.idle": ["notify-send done"],
    })

    delete process.env.SHELL_CMD
  })
})

// ── executeCommands() ─────────────────────────────────────────────────────────

describe("executeCommands()", () => {
  const log = jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const event = { type: "session.idle", properties: { id: "test-123" } }

  beforeEach(() => {
    log.mockClear()
  })

  it("executes a simple string command successfully", async () => {
    await executeCommands($, ["echo hello"], event, log)

    expect(log).not.toHaveBeenCalled()
  })

  it("executes multiple commands sequentially", async () => {
    await executeCommands(
      $,
      ["echo first", "echo second", "echo third"],
      event,
      log,
    )

    expect(log).not.toHaveBeenCalled()
  })

  it("logs a warning on non-zero exit code", async () => {
    await executeCommands($, ["false"], event, log)

    expect(log).toHaveBeenCalledTimes(1)
    const logMsg = (log.mock.calls[0] as unknown[])[0] as string
    expect(logMsg).toContain("exited with code")
  })

  it("continues executing commands after a failure", async () => {
    // "false" exits with code 1, "echo ok" should still run
    await executeCommands($, ["false", "echo ok"], event, log)

    // Only the first command should have logged a failure
    expect(log).toHaveBeenCalledTimes(1)
  })

  it("interpolates event data into command strings", async () => {
    // The command itself should work — we just verify it doesn't throw
    await executeCommands(
      $,
      ["echo {event.type}"],
      event,
      log,
    )

    expect(log).not.toHaveBeenCalled()
  })

  it("executes a command object with cwd", async () => {
    await executeCommands(
      $,
      [{ command: "pwd", cwd: "/tmp" }],
      event,
      log,
    )

    expect(log).not.toHaveBeenCalled()
  })

  it("executes a command object with env", async () => {
    await executeCommands(
      $,
      [{ command: "echo $MY_TEST_VAR", env: { MY_TEST_VAR: "test-value" } }],
      event,
      log,
    )

    expect(log).not.toHaveBeenCalled()
  })

  it("logs on timeout", async () => {
    await executeCommands(
      $,
      [{ command: "sleep 10", timeout: 100 }],
      event,
      log,
    )

    expect(log).toHaveBeenCalledTimes(1)
    const logMsg = (log.mock.calls[0] as unknown[])[0] as string
    expect(logMsg).toContain("timed out")
  })

  it("handles a mix of string and object commands", async () => {
    await executeCommands(
      $,
      [
        "echo simple",
        { command: "echo object", cwd: "/tmp" },
      ],
      event,
      log,
    )

    expect(log).not.toHaveBeenCalled()
  })
})

// ── EventShellExecPlugin ──────────────────────────────────────────────────────

describe("EventShellExecPlugin", () => {
  let readFileSyncSpy: ReturnType<typeof spyOn>
  let homedirSpy: ReturnType<typeof spyOn>

  const mockLog = jest.fn().mockResolvedValue(undefined)
  const mockClient = {
    app: {
      log: mockLog,
    },
  }

  const makeInput = (directory = "/proj") =>
    ({
      client: mockClient,
      $,
      directory,
    }) as unknown as Parameters<typeof EventShellExecPlugin>[0]

  beforeEach(() => {
    homedirSpy = spyOn(os, "homedir").mockReturnValue("/home/testuser")
    readFileSyncSpy = spyOn(fs, "readFileSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })
    mockLog.mockClear()
    spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    readFileSyncSpy.mockRestore()
    homedirSpy.mockRestore()
  })

  it("returns an empty object when no config exists", async () => {
    const hooks = await EventShellExecPlugin(makeInput())
    expect(hooks).toEqual({})
  })

  it("returns an event hook when config has patterns", async () => {
    readFileSyncSpy.mockImplementation((p: unknown) => {
      if ((p as string).includes("/proj/")) {
        return JSON.stringify({ "session.idle": ["echo done"] })
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })

    const hooks = await EventShellExecPlugin(makeInput())
    expect(typeof hooks.event).toBe("function")
  })

  it("executes commands for an exact event match", async () => {
    readFileSyncSpy.mockImplementation((p: unknown) => {
      if ((p as string).includes("/proj/")) {
        return JSON.stringify({ "session.idle": ["echo matched"] })
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })

    const hooks = await EventShellExecPlugin(makeInput())
    // Should not throw
    await expect(
      hooks.event!({ event: { type: "session.idle" } as any }),
    ).resolves.toBeUndefined()
  })

  it("does not execute commands when no patterns match", async () => {
    readFileSyncSpy.mockImplementation((p: unknown) => {
      if ((p as string).includes("/proj/")) {
        return JSON.stringify({ "session.idle": ["echo matched"] })
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })

    const hooks = await EventShellExecPlugin(makeInput())
    // file.edited does not match "session.idle"
    await expect(
      hooks.event!({ event: { type: "file.edited" } as any }),
    ).resolves.toBeUndefined()
  })

  it("executes commands for a catch-all '*' pattern", async () => {
    readFileSyncSpy.mockImplementation((p: unknown) => {
      if ((p as string).includes("/proj/")) {
        return JSON.stringify({ "*": ["echo any-event"] })
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })

    const hooks = await EventShellExecPlugin(makeInput())
    await expect(
      hooks.event!({ event: { type: "tool.execute.after" } as any }),
    ).resolves.toBeUndefined()
  })

  it("executes commands for a namespace wildcard pattern", async () => {
    readFileSyncSpy.mockImplementation((p: unknown) => {
      if ((p as string).includes("/proj/")) {
        return JSON.stringify({ "session.*": ["echo session-event"] })
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })

    const hooks = await EventShellExecPlugin(makeInput())
    await expect(
      hooks.event!({ event: { type: "session.created" } as any }),
    ).resolves.toBeUndefined()
  })

  it("dispatches multiple matching pattern groups in parallel", async () => {
    readFileSyncSpy.mockImplementation((p: unknown) => {
      if ((p as string).includes("/proj/")) {
        return JSON.stringify({
          "*": ["echo catch-all"],
          "session.*": ["echo session-ns"],
          "session.idle": ["echo exact"],
        })
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })

    const hooks = await EventShellExecPlugin(makeInput())
    // All three patterns should match "session.idle"
    await expect(
      hooks.event!({ event: { type: "session.idle" } as any }),
    ).resolves.toBeUndefined()
  })

  it("continues dispatching even if one pattern group has a failing command", async () => {
    readFileSyncSpy.mockImplementation((p: unknown) => {
      if ((p as string).includes("/proj/")) {
        return JSON.stringify({
          "session.idle": ["false"],
          "*": ["echo ok"],
        })
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })

    const hooks = await EventShellExecPlugin(makeInput())
    await expect(
      hooks.event!({ event: { type: "session.idle" } as any }),
    ).resolves.toBeUndefined()

    // The failing command should have been logged
    expect(mockLog).toHaveBeenCalled()
  })

  it("uses client.app.log to warn when a command fails", async () => {
    readFileSyncSpy.mockImplementation((p: unknown) => {
      if ((p as string).includes("/proj/")) {
        return JSON.stringify({ "session.idle": ["false"] })
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })

    const hooks = await EventShellExecPlugin(makeInput())
    await hooks.event!({ event: { type: "session.idle" } as any })

    expect(mockLog).toHaveBeenCalledTimes(1)
    const logCall = mockLog.mock.calls[0][0] as {
      body: Record<string, unknown>
    }
    expect(logCall.body.service).toBe("opencode-event-shell-exec")
    expect(logCall.body.level).toBe("warn")
  })
})
