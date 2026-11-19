"use strict";

import { spawn } from "child_process";
import * as path from "path";
import vscode = require("vscode");

const SPICE_LANGUAGE_ID = "spice";
const DEFAULT_COMPILER_PATH = "spice";

/**
 * Formats Spice documents with the formatter of the Spice compiler. 'spice format -' reads the source code from stdin and
 * prints the formatted code to stdout.
 */
export class SpiceFormattingProvider implements vscode.DocumentFormattingEditProvider {
  private compilerNotFoundReported = false;

  constructor(private readonly outputChannel: vscode.OutputChannel) {}

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken
  ): Promise<vscode.TextEdit[]> {
    const sourceCode = document.getText();
    const compilerPath = getCompilerPath(document.uri);
    const workingDir = document.uri.scheme === "file" ? path.dirname(document.uri.fsPath) : undefined;

    let formattedCode: string;
    try {
      formattedCode = await runFormatter(compilerPath, sourceCode, workingDir, token);
    } catch (error) {
      if (!token.isCancellationRequested) {
        this.reportError(error, compilerPath);
      }
      return [];
    }

    // The formatter emits line feeds. VS Code converts them to the line endings of the document when applying the edit
    if (token.isCancellationRequested || formattedCode === sourceCode.replace(/\r\n/g, "\n")) {
      return [];
    }
    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(sourceCode.length));
    return [vscode.TextEdit.replace(fullRange, formattedCode)];
  }

  private reportError(error: unknown, compilerPath: string): void {
    if (error instanceof CompilerNotFoundError) {
      // Only show the notification once, so that formatting on save does not show it over and over
      if (!this.compilerNotFoundReported) {
        this.compilerNotFoundReported = true;
        vscode.window.showErrorMessage(
          `Spice: The Spice compiler '${compilerPath}' was not found. Install Spice or set 'spice.compilerPath' in the settings.`
        );
      }
      return;
    }
    // Usually a syntax error in the document. Show it in the status bar instead of a notification, as the user might still
    // be typing
    const message = error instanceof Error ? error.message : String(error);
    this.outputChannel.appendLine(message);
    vscode.window.setStatusBarMessage("$(warning) Spice: Formatting failed, see the 'Spice' output for details", 5000);
  }
}

/**
 * Error, that is thrown if the Spice compiler executable cannot be started
 */
class CompilerNotFoundError extends Error {}

/**
 * Get the path of the Spice compiler from the settings
 *
 * @param uri URI of the document to format. Needed to honor the settings of its folder in multi-root workspaces
 * @returns Path of the compiler executable
 */
function getCompilerPath(uri: vscode.Uri): string {
  const configuredPath = vscode.workspace
    .getConfiguration("spice", uri)
    .get<string>("compilerPath", DEFAULT_COMPILER_PATH)
    .trim();
  return configuredPath.length > 0 ? configuredPath : DEFAULT_COMPILER_PATH;
}

/**
 * Run 'spice format -' with the given source code
 *
 * @param compilerPath Path of the Spice compiler executable
 * @param sourceCode Source code to format
 * @param workingDir Working directory for the compiler
 * @param token Cancellation token, that kills the compiler process
 * @returns Formatted source code
 */
function runFormatter(
  compilerPath: string,
  sourceCode: string,
  workingDir: string | undefined,
  token: vscode.CancellationToken
): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn(compilerPath, ["format", "-"], { cwd: workingDir });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const cancellation = token.onCancellationRequested(() => process.kill());

    process.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    process.on("error", (error: NodeJS.ErrnoException) => {
      cancellation.dispose();
      reject(error.code === "ENOENT" ? new CompilerNotFoundError(error.message) : error);
    });
    process.on("close", (exitCode: number | null) => {
      cancellation.dispose();
      const output = Buffer.concat(stdout).toString("utf8");
      if (exitCode === 0) {
        resolve(output);
        return;
      }
      // The compiler prints its errors, e.g. syntax errors, to stdout
      const errorOutput = Buffer.concat(stderr).toString("utf8") + output;
      reject(new Error(errorOutput.trim() || `'${compilerPath} format' exited with code ${exitCode}`));
    });

    // Errors on stdin are reported via the 'close' event as well, e.g. if the process exits before reading everything
    process.stdin.on("error", () => {});
    process.stdin.end(sourceCode, "utf8");
  });
}

/**
 * Register the formatter for Spice documents
 *
 * @param outputChannel Output channel for the formatter errors
 * @returns Disposable, that unregisters the formatter
 */
export function registerFormatter(outputChannel: vscode.OutputChannel): vscode.Disposable {
  return vscode.languages.registerDocumentFormattingEditProvider(
    { language: SPICE_LANGUAGE_ID },
    new SpiceFormattingProvider(outputChannel)
  );
}
