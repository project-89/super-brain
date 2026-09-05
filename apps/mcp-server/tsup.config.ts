import { defineConfig } from "tsup";

// SQLite is a prefix-only Node builtin. Stripping node: produces an invalid package import.
export default defineConfig({ target: "node24", removeNodeProtocol: false });
