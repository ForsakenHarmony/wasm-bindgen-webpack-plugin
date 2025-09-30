import type * as webpack from "webpack";

export type WebpackLogger = ReturnType<webpack.Compilation["getLogger"]>;

export function getInfrastructureLogger(compiler: webpack.Compiler): WebpackLogger {
  return compiler.getInfrastructureLogger("wasm-bindgen-webpack-plugin");
}

export function getLogger(compilation: webpack.Compilation): WebpackLogger {
  return compilation.getLogger("wasm-bindgen-webpack-plugin");
}
