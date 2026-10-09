// @effect-diagnostics nodeBuiltinImport:off - Demo host program: a plain Node boundary around the Forge services, not Effect domain code.
/**
 * Allowlisted verification runner. Only fixed commands can run, with a
 * timeout and bounded output, and the reported exit code is the real process
 * exit code (a timeout or spawn failure is never reported as a pass).
 */
import * as NodeChildProcess from "node:child_process";

import { redactText } from "../redact.ts";

export interface VerificationCommand {
  readonly label: string;
  readonly file: string;
  readonly args: ReadonlyArray<string>;
}

/** The only commands the demo will execute. */
export const ALLOWED_COMMANDS: Readonly<Record<string, VerificationCommand>> = {
  "node-test": { label: "node --test", file: process.execPath, args: ["--test"] },
};

export interface VerificationOutcome {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly output: string;
}

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export function runAllowlisted(commandKey: string, cwd: string): Promise<VerificationOutcome> {
  const command = ALLOWED_COMMANDS[commandKey];
  if (command === undefined) return Promise.reject(new Error(`Command not allowed: ${commandKey}`));
  const started = performance.now();
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      command.file,
      [...command.args],
      { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        resolve({
          command: command.label,
          cwd,
          // A killed (timed-out) or unspawnable process has no exit code and counts as failed.
          exitCode: error !== null && typeof error.code !== "number" ? -1 : code,
          durationMs: Math.round(performance.now() - started),
          output: redactText(`${stdout}${stderr}`).slice(-8_000),
        });
      },
    );
  });
}
