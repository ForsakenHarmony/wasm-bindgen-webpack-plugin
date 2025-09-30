import { type SpawnOptions, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Compilation, Compiler, WebpackPluginInstance } from "webpack";

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

    compiler.hooks.normalModuleFactory.tap("WasmBindgenWebpackPlugin", (normalModuleFactory) => {
      // Hook into the module resolution to intercept lib.rs imports
      normalModuleFactory.hooks.beforeResolve.tapAsync("WasmBindgenWebpackPlugin", (resolveData, callback) => {
        if (!resolveData.request.endsWith("lib.rs")) {
          return callback(null);
        }

        const libRsPath = path.resolve(resolveData.context, resolveData.request);

        if (!fs.existsSync(libRsPath)) {
          return callback(new Error(`lib.rs not found at ${libRsPath}`));
        }

        // Get manifest info using cargo read-manifest
        this.getManifestInfo(path.dirname(libRsPath))
          .then(({ manifestPath, crateName }) => {
            return this.compileRustCrate(manifestPath, crateName);
          })
          .then((result) => {
            // Replace the request with the generated JS file (modify in place)
            resolveData.request = result.jsPath;
            callback(null);
          })
          .catch((error) => {
            callback(error);
          });
      });
    });

    // Add file dependencies for hot reloading
    compiler.hooks.compilation.tap("WasmBindgenWebpackPlugin", (compilation: Compilation) => {
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
          this.addRustFilesToDependencies(srcDir, compilation);
        }
      }
    });

    // Ensure cache directory exists
    compiler.hooks.beforeRun.tap("WasmBindgenWebpackPlugin", () => {
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
      compiler.hooks.compilation.tap("WasmBindgenWebpackPlugin", (compilation: Compilation) => {
        if (compilation.compiler !== compiler) {
          // run only for the compiler that the plugin was registered for
          return;
        }

        compilationPromises.set(compilation, createPromise<null>());
      });

      hooks.start.tapAsync("WasmBindgenWebpackPlugin", async (_change, compilation, callback) => {
        try {
          // Wait for the current WASM compilation to complete
          await compilationPromises.get(compilation)?.promise;
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      });

      // Resolve the promise after the compilation is complete
      compiler.hooks.afterCompile.tap("WasmBindgenWebpackPlugin", (compilation) => {
        if (compilation.compiler !== compiler) {
          // run only for the compiler that the plugin was registered for
          return;
        }

        compilationPromises.get(compilation)?.resolve(null);
        compilationPromises.delete(compilation);
      });

      console.log("Integrated with `ForkTsCheckerWebpackPlugin` - TypeScript checking will wait for WASM compilation");
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

  private async compileRustCrate(cargoTomlPath: string, crateName: string): Promise<CompilationResult> {
    const cargoDir = path.dirname(cargoTomlPath);
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
      console.log(`Compiling Rust crate at ${cargoDir}...`);

      // Step 1: Get the target directory from cargo metadata
      const cargoTargetDir = await this.getCargoTargetDir(cargoDir);

      // Step 2: Compile Rust to WebAssembly
      await this.runCargoBuild(cargoDir, cargoTargetDir);

      // Step 3: Optionally run wasm-opt on the WebAssembly file
      const wasmFile = path.join(cargoTargetDir, "wasm32-unknown-unknown", "release", `${crateName}.wasm`);
      const optimizedWasmFile = await this.runWasmOpt(wasmFile);

      // Step 4: Run wasm-bindgen
      const result = await this.runWasmBindgen(optimizedWasmFile, crateName);

      // Cache the result
      this.compilationCache.set(cacheKey, result);

      console.log(`Successfully compiled ${crateName} to WebAssembly`);
      return result;
    } catch (error) {
      console.error(`Failed to compile Rust crate at ${cargoDir}:`, error);
      throw error;
    }
  }

  private async getCargoTargetDir(cargoDir: string): Promise<string> {
    // Check cache first
    if (this.cargoTargetDirCache.has(cargoDir)) {
      // biome-ignore lint/style/noNonNullAssertion: checked in the if condition
      return this.cargoTargetDirCache.get(cargoDir)!;
    }

    const { stdout } = await spawnProcess("cargo", ["metadata", "--format-version", "1"], {
      spawnOptions: {
        cwd: cargoDir,
      },
      errorPrefix: "cargo metadata",
    });

    const metadata: CargoMetadata = JSON.parse(stdout);
    const targetDirectory = metadata.target_directory;
    console.log(`Cargo target directory: ${targetDirectory}`);
    // Cache the result
    this.cargoTargetDirCache.set(cargoDir, targetDirectory);
    return targetDirectory;
  }

  private async runCargoBuild(cargoDir: string, cargoTargetDir: string): Promise<void> {
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
        cwd: cargoDir,
      },
      errorPrefix: "cargo build",
    });
  }

  private async runWasmOpt(inputWasmFile: string): Promise<string> {
    // If optimization is disabled, skip wasm-opt
    if (!this.options.optimizeWebassembly) {
      return inputWasmFile;
    }

    const optimizedWasmFile = inputWasmFile.replace(".wasm", ".opt.wasm");

    // Default optimization flags for good balance of size and performance
    const wasmOptArgs = [inputWasmFile, "-o", optimizedWasmFile, "-O"];

    console.log(`Running wasm-opt on ${inputWasmFile}...`);

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

  private addRustFilesToDependencies(dir: string, compilation: Compilation): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Recursively process subdirectories
          this.addRustFilesToDependencies(fullPath, compilation);
        } else if (entry.name.endsWith(".rs")) {
          // Add Rust source files as dependencies
          compilation.fileDependencies.add(fullPath);
        }
      }
    } catch (error) {
      // Ignore errors reading directory
    }
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
