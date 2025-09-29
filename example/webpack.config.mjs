import * as path from "node:path";
import { WasmBindgenWebpackPlugin } from "@harmony/wasm-bindgen-webpack-plugin";
import ForkTsCheckerWebpackPlugin from "fork-ts-checker-webpack-plugin";
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
        use: {
          loader: "ts-loader",
          options: {
            // ForkTsCheckerWebpackPlugin does async type checking
            transpileOnly: true,
          },
        },
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
    new ForkTsCheckerWebpackPlugin({
      // Make webpack wait for type checking to complete
      async: false,
      typescript: {
        diagnosticOptions: {
          semantic: true,
          syntactic: true,
        },
      },
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
