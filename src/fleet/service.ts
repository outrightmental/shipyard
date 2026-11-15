import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, posix, win32 } from "node:path";
import { REPO_ROOT } from "./machine.js";

/**
 * A fleet member as a service of its machine (#4): started with the machine,
 * and started again whenever it exits.
 *
 * What is installed runs the runner (tools/fleet-runner.mjs), once, and
 * starts it again when it exits — at once after an update (exit 75), after a
 * pause after anything else, and not at all once the member has stopped for
 * good (exit 0: an operator retired the machine). The runner is what installs
 * dependencies, builds the dashboard and starts the member, so everything
 * with any logic in it is read fresh from the checkout on every start, and
 * what is installed here never has to change.
 *
 *   Windows  a script the user's sign-in runs (the Run key of their own
 *            registry hive, which needs no administrator). The member needs
 *            the desktop session anyway: it shows its dashboard in a browser,
 *            and the Claude CLI's login is the user's.
 *   macOS    a launchd agent.
 *   Linux    a systemd user unit, with lingering so it runs without a login.
 */

export const SERVICE_NAME = "shipyard-fleet";
export const LAUNCHD_LABEL = "io.outright.shipyard-fleet";
/** The name of the value under the user's Run key. */
export const WINDOWS_RUN_VALUE = "ShipyardFleet";
const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

export interface ServiceOptions {
  home: string;
  repoRoot?: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
  osHome?: string;
  /** The PATH the service runs with: the enrolling shell's, where git and the Claude CLI were found. */
  path?: string;
  /** Say what would be done, and do none of it. */
  dryRun?: boolean;
  /** For tests: runs a command, returning its output or null when it fails. */
  exec?: (command: string, args: string[]) => string | null;
  /** For tests: starts a process that outlives this one. */
  launch?: (command: string, args: string[]) => void;
}

export interface ServiceResult {
  installed: boolean;
  kind: "windows-run" | "launchd" | "systemd" | "manual";
  /** What was written. */
  files: string[];
  /** What to run by hand: to finish what could not be done, and to see the member's log. */
  hints: string[];
  planned?: boolean;
}

function shell(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }).toString();
  } catch {
    return null;
  }
}

/** A process that outlives this one, with nothing of this one's attached to it. */
function launchDetached(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

/** A path as a single-quoted PowerShell string. */
const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * The runner, in the checkout, spelled for the machine the service runs on
 * rather than the one this happens to be read on.
 */
const runnerPath = (repoRoot: string, paths: typeof posix = posix): string => paths.join(repoRoot, "tools", "fleet-runner.mjs");

// ── Windows ──────────────────────────────────────────────────────────────────

/**
 * The script the user's sign-in runs: the runner, again and again. It stops
 * only when the member has (exit 0). Its output is the member's log.
 */
export function windowsServiceScript(options: { home: string; repoRoot: string; nodePath: string }): string {
  const { home, repoRoot, nodePath } = options;
  return [
    "# Shipyard fleet member: started at sign-in (npm run enroll). Do not edit: enroll again to rewrite it.",
    "$ErrorActionPreference = 'Continue'",
    `Set-Location -LiteralPath ${psQuote(repoRoot)}`,
    `$env:SHIPYARD_HOME = ${psQuote(home)}`,
    "$env:SHIPYARD_SUPERVISOR = 'windows-run'",
    `$log = Join-Path ${psQuote(home)} 'fleet.log'`,
    `Set-Content -LiteralPath (Join-Path ${psQuote(home)} 'service.pid') -Value $PID`,
    "while ($true) {",
    `  & ${psQuote(nodePath)} ${psQuote(runnerPath(repoRoot, win32))} *>> $log`,
    "  $code = $LASTEXITCODE",
    "  # 0: the member stopped for good. 75: start again now. Anything else: after a pause.",
    "  if ($code -eq 0) { break }",
    "  if ($code -ne 75) { Start-Sleep -Seconds 15 }",
    "}",
    "",
  ].join("\r\n");
}

/** The command the Run key holds, and that starts the service now. */
export function windowsServiceCommand(scriptFile: string): { command: string; args: string[] } {
  return { command: "powershell.exe", args: ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", scriptFile] };
}

// ── macOS ────────────────────────────────────────────────────────────────────

/** The launchd agent: kept alive unless the member exits cleanly, which is how it says it has stopped for good. */
export function launchdPlist(options: { home: string; repoRoot: string; nodePath: string; path: string }): string {
  const { home, repoRoot, nodePath, path } = options;
  const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const log = posix.join(home.replace(/\\/g, "/"), "fleet.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(nodePath)}</string><string>${esc(runnerPath(repoRoot))}</string></array>
  <key>WorkingDirectory</key><string>${esc(repoRoot)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>SHIPYARD_HOME</key><string>${esc(home)}</string>
    <key>SHIPYARD_SUPERVISOR</key><string>launchd</string>
    <key>PATH</key><string>${esc(path)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict></plist>
`;
}

// ── Linux ────────────────────────────────────────────────────────────────────

/** The systemd user unit: restarted on any exit but a clean one. */
export function systemdUnit(options: { home: string; repoRoot: string; nodePath: string; path: string; display?: Record<string, string> }): string {
  const { home, repoRoot, nodePath, path } = options;
  return [
    "[Unit]",
    "Description=Shipyard fleet member: hosts coding agents for the repositories Shipyard assigns this machine",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `WorkingDirectory=${repoRoot}`,
    // Quoted: systemd splits ExecStart on spaces.
    `ExecStart="${nodePath}" "${runnerPath(repoRoot)}"`,
    `Environment=SHIPYARD_HOME=${home}`,
    "Environment=SHIPYARD_SUPERVISOR=systemd",
    `Environment=PATH=${path}`,
    // The session the member opens its dashboard in, when it was enrolled from one.
    ...Object.entries(options.display ?? {}).map(([name, value]) => `Environment=${name}=${value}`),
    // A clean exit is the member stopping for good; anything else is started again.
    "Restart=on-failure",
    "RestartSec=5",
    "KillSignal=SIGTERM",
    // A member told to stop finishes what its agents are running first.
    "TimeoutStopSec=infinity",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

// ── Installing ───────────────────────────────────────────────────────────────

/**
 * Install the member as a service of this machine and start it. One already
 * installed is replaced, and the member it was running is stopped first.
 */
export function installService(options: ServiceOptions): ServiceResult {
  const platform = options.platform ?? os.platform();
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const nodePath = options.nodePath ?? process.execPath;
  const osHome = options.osHome ?? os.homedir();
  const path = options.path ?? process.env["PATH"] ?? "";
  const exec = options.exec ?? shell;
  const launch = options.launch ?? launchDetached;
  const { home, dryRun = false } = options;
  const logHint = `the member's log: ${join(home, "fleet.log")}`;

  if (platform === "win32") {
    const file = join(home, "fleet-service.ps1");
    const { command, args } = windowsServiceCommand(file);
    const runValue = `${command} ${args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ")}`;
    if (dryRun) return { installed: false, planned: true, kind: "windows-run", files: [file], hints: [`would start it at sign-in (${WINDOWS_RUN_KEY}\\${WINDOWS_RUN_VALUE})`] };
    mkdirSync(home, { recursive: true });
    stopWindowsService(home, exec);
    writeFileSync(file, windowsServiceScript({ home, repoRoot, nodePath }));
    const registered = exec("reg", ["add", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE, "/t", "REG_SZ", "/d", runValue, "/f"]) !== null;
    launch(command, args);
    return {
      installed: true,
      kind: "windows-run",
      files: [file],
      hints: [
        ...(registered ? [] : [`it is running now, but could not be set to start at sign-in: reg add "${WINDOWS_RUN_KEY}" /v ${WINDOWS_RUN_VALUE} /t REG_SZ /d "${runValue.replace(/"/g, '\\"')}" /f`]),
        logHint,
      ],
    };
  }

  if (platform === "darwin") {
    const dir = join(osHome, "Library", "LaunchAgents");
    const file = join(dir, `${LAUNCHD_LABEL}.plist`);
    if (dryRun) return { installed: false, planned: true, kind: "launchd", files: [file], hints: [] };
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(file, launchdPlist({ home, repoRoot, nodePath, path }));
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    // One already loaded is unloaded first, so the new plist is the one that runs.
    exec("launchctl", ["bootout", `gui/${uid}`, file]);
    const installed = exec("launchctl", ["bootstrap", `gui/${uid}`, file]) !== null;
    return { installed, kind: "launchd", files: [file], hints: [...(installed ? [] : [`launchctl bootstrap gui/${uid} ${file}`]), logHint] };
  }

  if (platform === "linux") {
    const dir = join(osHome, ".config", "systemd", "user");
    const file = join(dir, `${SERVICE_NAME}.service`);
    const display: Record<string, string> = {};
    for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
      const value = process.env[name];
      if (value) display[name] = value;
    }
    if (dryRun) return { installed: false, planned: true, kind: "systemd", files: [file], hints: [] };
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(file, systemdUnit({ home, repoRoot, nodePath, path, display }));
    const reloaded = exec("systemctl", ["--user", "daemon-reload"]) !== null;
    const enabled = exec("systemctl", ["--user", "enable", `${SERVICE_NAME}.service`]) !== null;
    const started = exec("systemctl", ["--user", "restart", `${SERVICE_NAME}.service`]) !== null;
    const user = os.userInfo().username;
    const linger = exec("loginctl", ["enable-linger", user]) !== null;
    const installed = reloaded && enabled && started;
    return {
      installed,
      kind: "systemd",
      files: [file],
      hints: [
        ...(installed ? [] : [`systemctl --user enable --now ${SERVICE_NAME}.service`]),
        ...(linger ? [] : [`sudo loginctl enable-linger ${user}   # so it runs without a login session`]),
        `the member's log: journalctl --user -u ${SERVICE_NAME} -f`,
      ],
    };
  }

  return {
    installed: false,
    kind: "manual",
    files: [],
    hints: [`no service manager is known here: keep this running under one of your own:  "${nodePath}" "${join(repoRoot, "tools", "fleet-runner.mjs")}"`],
  };
}

/** Stop the member the Windows script is running, and the script: before it is replaced. */
function stopWindowsService(home: string, exec: (command: string, args: string[]) => string | null): void {
  const pidFile = join(home, "service.pid");
  if (!existsSync(pidFile)) return;
  const pid = readFileSync(pidFile, "utf8").trim();
  if (!/^\d+$/.test(pid)) return;
  // /T takes the runner and the member with it: one member per machine.
  exec("taskkill", ["/PID", pid, "/T", "/F"]);
}
