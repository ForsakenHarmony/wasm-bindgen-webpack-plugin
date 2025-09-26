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
  // biome-ignore lint/style/useNamingConvention: third party json
  target_directory: string;
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
    compiler.hooks.normalModuleFactory.tap("WasmBindgenWebpackPlugin", (normalModuleFactory) => {
      // Hook into the module resolution to intercept Cargo.toml imports
      normalModuleFactory.hooks.beforeResolve.tapAsync("WasmBindgenWebpackPlugin", (resolveData, callback) => {
        if (!resolveData.request.endsWith("Cargo.toml")) {
          return callback(null);
        }

        const cargoTomlPath = path.resolve(resolveData.context, resolveData.request);

        if (!fs.existsSync(cargoTomlPath)) {
          return callback(new Error(`Cargo.toml not found at ${cargoTomlPath}`));
        }

        this.compileRustCrate(cargoTomlPath)
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

  private async compileRustCrate(cargoTomlPath: string): Promise<CompilationResult> {
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

      // Read Cargo.toml to get the package name
      const cargoToml = fs.readFileSync(cargoTomlPath, "utf-8");
      const packageName = this.extractPackageName(cargoToml);

      // Step 1: Get the target directory from cargo metadata
      const cargoTargetDir = await this.getCargoTargetDir(cargoDir);

      // Step 2: Compile Rust to WebAssembly
      await this.runCargoBuild(cargoDir, cargoTargetDir);

      // Step 3: Optionally run wasm-opt on the WebAssembly file
      const wasmFile = path.join(cargoTargetDir, "wasm32-unknown-unknown", "release", `${packageName}.wasm`);
      const optimizedWasmFile = await this.runWasmOpt(wasmFile);

      // Step 4: Run wasm-bindgen
      const result = await this.runWasmBindgen(optimizedWasmFile, packageName);

      // Cache the result
      this.compilationCache.set(cacheKey, result);

      console.log(`Successfully compiled ${packageName} to WebAssembly`);
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
      options: {
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
      options: {
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

    console.log("wasm-opt completed successfully");
    return optimizedWasmFile;
  }

  private async runWasmBindgen(wasmFile: string, packageName: string): Promise<CompilationResult> {
    const outputDir = path.join(this.options.cacheDir, packageName);

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

    return {
      jsPath: path.join(outputDir, "index.js"),
      wasmPath: path.join(outputDir, "index_bg.wasm"),
      dtsPath: path.join(outputDir, "index.d.ts"),
    };
  }

  private extractPackageName(cargoToml: string): string {
    const nameMatch = cargoToml.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    if (!nameMatch) {
      throw new Error("Could not find package name in Cargo.toml");
    }
    return nameMatch[1].replace(/-/g, "_"); // Rust converts hyphens to underscores in filenames
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
  options?: Exclude<SpawnOptions, "stdio">;
  errorPrefix?: string;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
}

async function spawnProcess(
  command: string,
  args: string[],
  { options, errorPrefix }: SpawnProcessOptions = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, {
      stdio: ["inherit", "pipe", "pipe"],
      ...options,
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
