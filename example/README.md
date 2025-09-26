# WASM Bindgen Webpack Plugin Example

This example demonstrates how to use the `wasm-bindgen-webpack-plugin` to automatically compile Rust code to WebAssembly.

## What this example shows

- 🦀 **Rust Library**: A complete Rust crate with various functions and a class
- 📦 **Automatic Compilation**: Import `Cargo.toml` and get compiled WebAssembly
- 🎯 **TypeScript Support**: Generated TypeScript declarations
- 🌐 **Web Integration**: Full webpack setup with dev server

## Prerequisites

Make sure you have:
- [Rust](https://rustup.rs/) installed
- WebAssembly target: `rustup target add wasm32-unknown-unknown`
- wasm-bindgen: `cargo install wasm-bindgen-cli`

## Quick Start

1. **Build the plugin first:**
   ```bash
   cd ..
   npm install
   npm run build
   ```

2. **Run the example:**
   ```bash
   cd example
   npm install
   npm run serve
   ```

3. **Open your browser to http://localhost:8080**

## What happens when you run it

1. Webpack detects the import of `../rust-lib/Cargo.toml`
2. The plugin compiles the Rust crate to WebAssembly
3. wasm-bindgen generates JavaScript bindings
4. The example calls various Rust functions from JavaScript
5. You see the output both in browser console and the custom UI

## Available Scripts

- `npm run dev` - Build in development mode
- `npm run build` - Build for production
- `npm run serve` - Start development server with hot reload

## The Rust Library

The example Rust library (`rust-lib/`) includes:

- **Simple functions**: `greet()`, `add()`, `fibonacci()`
- **Classes**: A `Calculator` class with state
- **Web APIs**: Uses `console.log` from JavaScript
- **wasm-bindgen**: Proper annotations for WebAssembly export
