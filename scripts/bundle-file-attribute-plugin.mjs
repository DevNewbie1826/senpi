#!/usr/bin/env node

import { readFileSync } from "node:fs";

// Bun's file attribute is not a standard Node import attribute. Let esbuild
// emit the asset and its path rather than parse it as a JavaScript module.
export const fileAttributePlugin = {
	name: "file-attribute",
	setup(build) {
		build.onLoad({ filter: /./, namespace: "file" }, (args) => {
			if (args.with.type !== "file") return undefined;
			return { contents: readFileSync(args.path), loader: "file" };
		});
	},
};
