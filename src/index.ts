import { type SpawnOptions, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Compilation, Compiler, WebpackPluginInstance } from "webpack";

import type { WebpackLogger } from "./logger";
import { getInfrastructureLogger, getLogger } from "./logger";

export interface WasmBindgenWebpackPluginOptions {
  /** Directory where compiled wasm files will be cached */
  cacheDir?: string;
  /** Additional cargo build flags */
  cargoArgs?: string[];
  /** Additional wasm-bindgen flags */
  wasmBindgenArgs?: string[];
  /** Enable WebAssembly optimization with wasm-opt before running wasm-bindgen */
  optimizeWebassembly?: boolean;
}

interface CompilationResult {
  jsPath: string;
  wasmPath: string;
  dtsPath?: string;
}

interface CargoMetadata {
  // biome-ignore lint/style/useNamingConvention: third party JSON
  target_directory: string;
  [key: string]: unknown;
}

interface CargoManifest {
  // biome-ignore lint/style/useNamingConvention: third party JSON
  manifest_path: string;
  targets: Array<{
    name: string;
    // biome-ignore lint/style/useNamingConvention: third party JSON
    crate_types: string[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

const PLUGIN_NAME = "WasmBindgenWebpackPlugin";

export class WasmBindgenWebpackPlugin implements WebpackPluginInstance {
  private options: Required<WasmBindgenWebpackPluginOptions>;
  private compilationCache: Map<string, CompilationResult> = new Map();
  private cargoTargetDirCache: Map<string, string> = new Map();

  constructor(options: WasmBindgenWebpackPluginOptions = {}) {
    this.options = {
      cacheDir: options.cacheDir ? path.resolve(options.cacheDir) : path.join(process.cwd(), ".cache/wasm"),
      cargoArgs: options.cargoArgs || ["--release"],
      wasmBindgenArgs: options.wasmBindgenArgs || [],
      optimizeWebassembly: options.optimizeWebassembly || false,
    };
  }

  apply(compiler: Compiler): void {
    // Integrate with ForkTsCheckerWebpackPlugin if it exists
    this.setupForkTsCheckerIntegration(compiler);

    compiler.hooks.normalModuleFactory.tap(PLUGIN_NAME, (normalModuleFactory) => {
      // Hook into the module resolution to intercept lib.rs imports
      normalModuleFactory.hooks.beforeResolve.tapPromise(PLUGIN_NAME, async (resolveData) => {
        if (!resolveData.request.endsWith("lib.rs")) {
          return;
        }

        const logger = getInfrastructureLogger(compiler);

        const libRsPath = path.resolve(resolveData.context, resolveData.request);

        if (!fs.existsSync(libRsPath)) {
          throw new Error(`lib.rs not found at ${libRsPath}`);
        }

        // Get manifest info using cargo read-manifest
        const { manifestPath, crateName } = await this.getManifestInfo(path.dirname(libRsPath));
        const crateDir = path.dirname(manifestPath);

        const result = await this.compileRustCrate({ crateDir, crateName, logger });

        // Replace the request with the generated JS file (modify in place)
        resolveData.request = result.jsPath;

        return;
      });
    });

    // Add file dependencies for hot reloading
    compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation: Compilation) => {
      if (compilation.compiler !== compiler) {
        // run only for the compiler that the plugin was registered for
        return;
      }

      // Add all known Cargo.toml files and their Rust sources as dependencies
      for (const [cargoTomlPath] of this.compilationCache.entries()) {
        const cargoDir = path.dirname(cargoTomlPath);

        // Add Cargo.toml to dependencies
        compilation.fileDependencies.add(cargoTomlPath);

        // Add all .rs files in src/ directory
        const srcDir = path.join(cargoDir, "src");
        if (fs.existsSync(srcDir)) {
          compilation.contextDependencies.add(srcDir);
        }
      }
    });

    // Ensure cache directory exists
    compiler.hooks.beforeRun.tap(PLUGIN_NAME, () => {
      if (!fs.existsSync(this.options.cacheDir)) {
        fs.mkdirSync(this.options.cacheDir, { recursive: true });
      }
    });
  }

  private setupForkTsCheckerIntegration(compiler: Compiler): void {
    try {
      // Check if ForkTsCheckerWebpackPlugin is available
      // biome-ignore format: the import should not be formatted, typescript doesn't like a trailing comma.
      const ForkTsCheckerWebpackPlugin: typeof import("fork-ts-checker-webpack-plugin")
        = require("fork-ts-checker-webpack-plugin");

      const hooks = ForkTsCheckerWebpackPlugin.getCompilerHooks(compiler);

      const compilationPromises: WeakMap<Compilation, PromiseWithResolveAndReject<null>> = new WeakMap();

      // Delay ForkTsChecker start until the current WASM compilation completes
      compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation: Compilation) => {
        if (compilation.compiler !== compiler) {
          // run only for the compiler that the plugin was registered for
          return;
        }

        compilationPromises.set(compilation, createPromise<null>());
      });

      hooks.start.tapAsync(PLUGIN_NAME, async (_change, compilation, callback) => {
        const logger = getLogger(compilation);

        try {
          logger.debug("making TsChecker wait for compilation");

          // Wait for the current WASM compilation to complete
          await compilationPromises.get(compilation)?.promise;

          logger.debug("compilation done");
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      });

      // Resolve the promise after the compilation is complete
      compiler.hooks.afterCompile.tap(PLUGIN_NAME, (compilation) => {
        if (compilation.compiler !== compiler) {
          // run only for the compiler that the plugin was registered for
          return;
        }

        compilationPromises.get(compilation)?.resolve(null);
        compilationPromises.delete(compilation);
      });

      const logger = getInfrastructureLogger(compiler);

      logger.debug("integrated with `ForkTsCheckerWebpackPlugin`");
    } catch (error) {
      // ForkTsCheckerWebpackPlugin is not installed or not available.
    }
  }

  private async getManifestInfo(libRsDir: string): Promise<{ manifestPath: string; crateName: string }> {
    const { stdout } = await spawnProcess("cargo", ["read-manifest"], {
      spawnOptions: {
        cwd: libRsDir,
      },
      errorPrefix: "cargo read-manifest",
    });

    const manifest: CargoManifest = JSON.parse(stdout);
    const cdylibTarget = manifest.targets.find((target) => target.crate_types.includes("cdylib"));

    if (!cdylibTarget) {
      throw new Error(
        'No cdylib target found in Cargo.toml. Make sure your Cargo.toml includes [lib] with crate-type = ["cdylib"]',
      );
    }

    return {
      manifestPath: manifest.manifest_path,
      crateName: cdylibTarget.name,
    };
  }

  private async compileRustCrate({
    crateDir,
    crateName,
    logger,
  }: { crateDir: string; crateName: string; logger: WebpackLogger }): Promise<CompilationResult> {
    const cargoTomlPath = path.join(crateDir, "Cargo.toml");
    const cacheKey = cargoTomlPath;

    // Check if we have a cached result
    if (this.compilationCache.has(cacheKey)) {
      // biome-ignore lint/style/noNonNullAssertion: checked in the if condition
      const cached = this.compilationCache.get(cacheKey)!;
      if (this.isResultValid(cached, cargoTomlPath)) {
        return cached;
      }
    }

    try {
      logger.info(`Compiling Rust crate: ${crateDir}`);

      // Step 1: Get the target directory from cargo metadata
      const cargoTargetDir = await this.getCargoTargetDir({ crateDir, logger });

      // Step 2: Compile Rust to WebAssembly
      await this.runCargoBuild({ crateDir, cargoTargetDir });

      // Step 3: Optionally run wasm-opt on the WebAssembly file
      const wasmFile = path.join(cargoTargetDir, "wasm32-unknown-unknown", "release", `${crateName}.wasm`);
      const optimizedWasmFile = await this.runWasmOpt({ wasmFile, logger });

      // Step 4: Run wasm-bindgen
      const result = await this.runWasmBindgen(optimizedWasmFile, crateName);

      // Cache the result
      this.compilationCache.set(cacheKey, result);

      logger.info(`Successfully compiled: ${crateName}`);
      return result;
    } catch (error) {
      logger.error(`Failed to compile Rust crate at: ${crateDir}`, error);
      throw error;
    }
  }

  private async getCargoTargetDir({ crateDir, logger }: { crateDir: string; logger: WebpackLogger }): Promise<string> {
    // Check cache first
    if (this.cargoTargetDirCache.has(crateDir)) {
      // biome-ignore lint/style/noNonNullAssertion: checked in the if condition
      return this.cargoTargetDirCache.get(crateDir)!;
    }

    const { stdout } = await spawnProcess("cargo", ["metadata", "--format-version", "1"], {
      spawnOptions: {
        cwd: crateDir,
      },
      errorPrefix: "cargo metadata",
    });

    const metadata: CargoMetadata = JSON.parse(stdout);
    const targetDirectory = metadata.target_directory;

    // Cache the result
    this.cargoTargetDirCache.set(crateDir, targetDirectory);

    logger.debug(`Cargo target directory: ${targetDirectory}`);
    return targetDirectory;
  }

  private async runCargoBuild({
    crateDir,
    cargoTargetDir,
  }: { crateDir: string; cargoTargetDir: string }): Promise<void> {
    const cargoArgs = [
      "build",
      "--target",
      "wasm32-unknown-unknown",
      "--target-dir",
      cargoTargetDir,
      ...this.options.cargoArgs,
    ];

    await spawnProcess("cargo", cargoArgs, {
      spawnOptions: {
        cwd: crateDir,
      },
      errorPrefix: "cargo build",
    });
  }

  private async runWasmOpt({ wasmFile, logger }: { wasmFile: string; logger: WebpackLogger }): Promise<string> {
    // If optimization is disabled, skip wasm-opt
    if (!this.options.optimizeWebassembly) {
      return wasmFile;
    }

    const optimizedWasmFile = wasmFile.replace(".wasm", ".opt.wasm");

    // Default optimization flags for good balance of size and performance
    const wasmOptArgs = [wasmFile, "-o", optimizedWasmFile, "-O"];

    logger.info(`Running wasm-opt on: ${wasmFile}`);

    await spawnProcess("wasm-opt", wasmOptArgs);

    return optimizedWasmFile;
  }

  private async runWasmBindgen(wasmFile: string, crateName: string): Promise<CompilationResult> {
    const outputDir = path.join(this.options.cacheDir, crateName);

    // Create output directory
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const wasmBindgenArgs = [
      wasmFile,
      "--out-dir",
      outputDir,
      "--out-name",
      "index",
      "--typescript",
      ...this.options.wasmBindgenArgs,
    ];

    await spawnProcess("wasm-bindgen", wasmBindgenArgs, {});

    // Generate package.json for the output
    const packageJsonContent = {
      name: crateName,
      version: "0.0.0",
      main: "index.js",
      types: "index.d.ts",
      sideEffects: true,
      private: true,
    };

    const packageJsonPath = path.join(outputDir, "package.json");
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJsonContent, null, 2)}\n`);

    return {
      jsPath: path.join(outputDir, "index.js"),
      wasmPath: path.join(outputDir, "index_bg.wasm"),
      dtsPath: path.join(outputDir, "index.d.ts"),
    };
  }

  private isResultValid(result: CompilationResult, cargoTomlPath: string): boolean {
    try {
      // Check if all generated files still exist
      const filesExist =
        fs.existsSync(result.jsPath) &&
        fs.existsSync(result.wasmPath) &&
        (!result.dtsPath || fs.existsSync(result.dtsPath));

      if (!filesExist) {
        return false;
      }

      // Check if Cargo.toml has been modified more recently than generated files
      const cargoTomlStat = fs.statSync(cargoTomlPath);
      const jsStat = fs.statSync(result.jsPath);

      if (cargoTomlStat.mtime > jsStat.mtime) {
        return false;
      }

      // Check if any Rust source files have been modified more recently
      const cargoDir = path.dirname(cargoTomlPath);
      const srcDir = path.join(cargoDir, "src");

      if (fs.existsSync(srcDir)) {
        return this.areRustFilesUpToDate(srcDir, jsStat.mtime);
      }

      return true;
    } catch {
      return false;
    }
  }

  private areRustFilesUpToDate(dir: string, generatedTime: Date): boolean {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!this.areRustFilesUpToDate(fullPath, generatedTime)) {
            return false;
          }
        } else if (entry.name.endsWith(".rs")) {
          const rustStat = fs.statSync(fullPath);
          if (rustStat.mtime > generatedTime) {
            return false; // Rust file is newer than generated JS
          }
        }
      }

      return true;
    } catch {
      return false;
    }
  }
}

interface SpawnProcessOptions {
  spawnOptions?: Exclude<SpawnOptions, "stdio">;
  errorPrefix?: string;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
}

async function spawnProcess(
  command: string,
  args: string[],
  { spawnOptions, errorPrefix }: SpawnProcessOptions = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, {
      stdio: ["inherit", "pipe", "pipe"],
      ...spawnOptions,
    });

    let stdout = "";
    let stderr = "";

    if (childProcess.stdout) {
      childProcess.stdout.on("data", (data: any) => {
        stdout += data.toString();
      });
    }

    if (childProcess.stderr) {
      childProcess.stderr.on("data", (data: any) => {
        stderr += data.toString();
      });
    }

    childProcess.on("close", (code: number | null) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const prefix = errorPrefix || command;
        reject(new Error(`${prefix} failed with exit code ${code}:\n${stderr}`));
      }
    });

    childProcess.on("error", (error: any) => {
      const prefix = errorPrefix || command;
      reject(new Error(`Failed to spawn ${prefix}: ${error.message}`));
    });
  });
}

interface PromiseWithResolveAndReject<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
}

function createPromise<T>(): PromiseWithResolveAndReject<T> {
  let resolve: (value: T | PromiseLike<T>) => void;
  let reject: (reason?: any) => void;

  const promise = new Promise<T>((res, rej) => {
    reject = rej;
    resolve = res;
  });

  return {
    promise,
    // biome-ignore lint/style/noNonNullAssertion: resolve and reject are assigned in the promise constructor.
    resolve: resolve!,
    // biome-ignore lint/style/noNonNullAssertion: resolve and reject are assigned in the promise constructor.
    reject: reject!,
  };
}
