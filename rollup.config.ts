import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const plugins = [typescript(), nodeResolve({ preferBuiltins: true }), commonjs()];

const action = {
  input: "src/index.ts",
  output: {
    esModule: true,
    file: "dist/index.js",
    format: "es",
    sourcemap: true,
  },
  plugins,
};

const server = {
  input: "src/server.ts",
  output: {
    esModule: true,
    file: "dist/server.js",
    format: "es",
    sourcemap: true,
  },
  plugins,
};

export default [action, server];
