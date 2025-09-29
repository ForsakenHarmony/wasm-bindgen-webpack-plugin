import * as path from "node:path";
import { WasmBindgenWebpackPlugin } from "@harmony/wasm-bindgen-webpack-plugin";
import HtmlWebpackPlugin from "html-webpack-plugin";

export default {
  entry: "./src/index.ts",
  output: {
    path: path.resolve(import.meta.dirname, "dist"),
    filename: "bundle.js",
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: [".tsx", ".ts", ".js"],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: "src/index.html",
      title: "WASM Bindgen Webpack Plugin Example",
    }),
    new WasmBindgenWebpackPlugin({
      optimizeWebassembly: true,
    }),
  ],
  experiments: {
    asyncWebAssembly: true,
  },
  devServer: {
    static: path.join(import.meta.dirname, "dist"),
    compress: true,
    port: 8080,
  },
};
