# wasm-bindgen-webpack-plugin

WARNING: Most of this plugin was written by an LLM.

A Webpack plugin that automatically compiles Rust crates to WebAssembly when you import `Cargo.toml` files.

## Features

- 🦀 **Automatic Rust compilation**: Compiles Rust crates to WebAssembly when importing `Cargo.toml`
- 🚀 **wasm-bindgen integration**: Automatically runs `wasm-bindgen` to generate JS bindings
- 💾 **Smart caching**: Avoids recompilation when source hasn't changed
- 🎯 **TypeScript support**: Generates TypeScript declarations
- ⚡  **Webpack integration**: Seamless integration with Webpack's module system

## Prerequisites

Make sure you have the following tools installed:

- [Rust](https://rustup.rs/) with `wasm32-unknown-unknown` target
- [wasm-bindgen](https://rustwasm.github.io/wasm-bindgen/install.html)

```bash
# Install the WebAssembly target
rustup target add wasm32-unknown-unknown

# Install wasm-bindgen-cli
cargo install wasm-bindgen-cli
```

## Installation

```bash
pnpm install wasm-bindgen-webpack-plugin
```

## Quick Start

1. **Build the plugin:**

   ```bash
   pnpm install
   pnpm run build
   ```

2. **Try the complete example:**

   ```bash
   cd example
   pnpm install
   pnpm run dev
   ```

3. **Open your browser to <http://localhost:8080>**

## Usage

### TypeScript Interface

The plugin accepts the following configuration options:

```typescript
interface WasmBindgenWebpackPluginOptions {
  /** Directory where compiled wasm files will be cached */
  cacheDir?: string;
  /** Additional cargo build flags */
  cargoArgs?: string[];
  /** Additional wasm-bindgen flags */
  wasmBindgenArgs?: string[];
}
```

### 1. Configure Webpack

Add the plugin to your webpack configuration:

```javascript
// webpack.config.js
const WasmBindgenWebpackPlugin = require("wasm-bindgen-webpack-plugin");

module.exports = {
  // ... other webpack config
  plugins: [
    new WasmBindgenWebpackPlugin({
      // Optional: Custom cache directory (default: ".cache/wasm")
      cacheDir: ".wasm-cache",

      // Optional: Additional cargo build flags (default: ["--release"])
      cargoArgs: ["--release"],

      // Optional: Additional wasm-bindgen flags (default: [])
      // Note: --typescript is automatically added by the plugin
      wasmBindgenArgs: [],
    })
  ]
};
```

### 2. Create a Rust Crate

Create a Rust crate with WebAssembly bindings:

```toml
# my-rust-lib/Cargo.toml
[package]
name = "my-rust-lib"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"

[dependencies.web-sys]
version = "0.3"
features = [
  "console",
]
```

```rust
// my-rust-lib/src/lib.rs
use wasm_bindgen::prelude::*;

// Import the `console.log` function from the `console` module from the web-sys crate
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

// Define a macro to provide `console.log!(..)` syntax
macro_rules! console_log {
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}

#[wasm_bindgen]
pub fn greet(name: &str) {
    console_log!("Hello, {}!", name);
}

#[wasm_bindgen]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
```

### 3. Import in JavaScript/TypeScript

Now you can import the Rust crate directly by importing its `Cargo.toml`:

```typescript
// Import the Rust crate - the plugin will compile it automatically!
import * as wasmModule from './my-rust-lib/Cargo.toml';

// Use the exported functions
wasmModule.greet("WebAssembly");
const result = wasmModule.add(5, 3);
console.log(result); // 8
```

## How it Works

1. **Detection**: The plugin hooks into Webpack's module resolution to detect when you import a `Cargo.toml` file
2. **Target Directory Discovery**: Uses `cargo metadata` to determine the correct target directory for the project
3. **Compilation**: When detected, it:
   - Runs `cargo build --target wasm32-unknown-unknown --target-dir <discovered-target-dir>` to compile the Rust crate to WebAssembly
   - Runs `wasm-bindgen` on the resulting `.wasm` file to generate JavaScript bindings and TypeScript declarations
4. **Caching**: Results are cached in the specified cache directory and only recompiled when the `Cargo.toml` or Rust source files change
5. **Integration**: The generated JavaScript file is returned to Webpack as if you had imported it directly
6. **Hot Reloading**: All Rust source files and `Cargo.toml` are added as file dependencies for proper hot reloading

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cacheDir` | `string` | `".cache/wasm"` | Directory where compiled WASM files are cached |
| `cargoArgs` | `string[]` | `["--release"]` | Additional arguments passed to `cargo build` |
| `wasmBindgenArgs` | `string[]` | `[]` | Additional arguments passed to `wasm-bindgen` (Note: `--typescript` is automatically added) |

**Note**: The plugin automatically determines the Cargo target directory using `cargo metadata` and doesn't require manual configuration.

## Examples

### Development vs Production

```javascript
// webpack.config.js
const isProduction = process.env.NODE_ENV === "production";

module.exports = {
  plugins: [
    new WasmBindgenWebpackPlugin({
      cargoArgs: isProduction ? ["--release"] : [],
      wasmBindgenArgs: isProduction ? [] : ["--debug"]
    })
  ]
};
```

### Custom Cache Directory

```javascript
// webpack.config.js
const path = require("path");

module.exports = {
  plugins: [
    new WasmBindgenWebpackPlugin({
      cacheDir: path.join(__dirname, ".wasm-cache")
    })
  ]
};
```

### Development Mode (No Release Optimization)

```javascript
// webpack.config.js
module.exports = {
  plugins: [
    new WasmBindgenWebpackPlugin({
      cargoArgs: [], // No --release flag for faster debug builds
      wasmBindgenArgs: ["--debug"] // Optional debug mode for wasm-bindgen
    })
  ]
};
```

## Troubleshooting

### Common Issues

1. **"cargo: command not found"**: Make sure Rust is installed and in your PATH
2. **"wasm-bindgen: command not found"**: Install wasm-bindgen-cli with `cargo install wasm-bindgen-cli`
3. **"target 'wasm32-unknown-unknown' not installed"**: Run `rustup target add wasm32-unknown-unknown`

### Performance Tips

- The plugin caches compilation results, so subsequent builds are much faster
- Use `--release` flag for production builds for smaller and faster WebAssembly modules
- Consider using `wee_alloc` as a global allocator in your Rust code to reduce bundle size
