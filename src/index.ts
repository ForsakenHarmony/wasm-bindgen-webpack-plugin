import { spawn } from "node:child_process";
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

      // Step 3: Run wasm-bindgen
      const wasmFile = path.join(cargoTargetDir, "wasm32-unknown-unknown", "release", `${packageName}.wasm`);
      const result = await this.runWasmBindgen(wasmFile, packageName);

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

    return new Promise((resolve, reject) => {
      const cargo = spawn("cargo", ["metadata", "--format-version", "1"], {
        cwd: cargoDir,
        stdio: ["inherit", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      cargo.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      cargo.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      cargo.on("close", (code) => {
        if (code === 0) {
          try {
            const metadata: CargoMetadata = JSON.parse(stdout);
            const targetDir = metadata.target_directory;
            console.log(`Cargo target directory: ${targetDir}`);
            // Cache the result
            this.cargoTargetDirCache.set(cargoDir, targetDir);
            resolve(targetDir);
          } catch (error) {
            reject(new Error(`Failed to parse cargo metadata: ${error}`));
          }
        } else {
          reject(new Error(`cargo metadata failed with exit code ${code}:\n${stderr}`));
        }
      });

      cargo.on("error", (error) => {
        reject(new Error(`Failed to spawn cargo: ${error.message}`));
      });
    });
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

    return new Promise((resolve, reject) => {
      const cargo = spawn("cargo", cargoArgs, {
        cwd: cargoDir,
        stdio: ["inherit", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      cargo.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      cargo.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      cargo.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`cargo build failed with exit code ${code}:\n${stderr}`));
        }
      });

      cargo.on("error", (error) => {
        reject(new Error(`Failed to spawn cargo: ${error.message}`));
      });
    });
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

    return new Promise((resolve, reject) => {
      const wasmBindgen = spawn("wasm-bindgen", wasmBindgenArgs, {
        stdio: ["inherit", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      wasmBindgen.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      wasmBindgen.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      wasmBindgen.on("close", (code) => {
        if (code === 0) {
          const result: CompilationResult = {
            jsPath: path.join(outputDir, "index.js"),
            wasmPath: path.join(outputDir, "index_bg.wasm"),
            dtsPath: path.join(outputDir, "index.d.ts"),
          };
          resolve(result);
        } else {
          reject(new Error(`wasm-bindgen failed with exit code ${code}:\n${stderr}`));
        }
      });

      wasmBindgen.on("error", (error) => {
        reject(new Error(`Failed to spawn wasm-bindgen: ${error.message}`));
      });
    });
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
