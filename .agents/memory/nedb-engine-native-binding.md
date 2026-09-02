---
name: nedb-engine native binding vs esbuild
description: Why nedb-engine must stay external in the api-server bundle, and how the failure presents.
---

`nedb-engine` resolves its prebuilt `.node` binding with `existsSync(join(__dirname, ...))`
and only falls back to a per-platform npm package (`nedb-engine-linux-x64-gnu`)
when that file is missing. Those fallback packages are not published.

**Rule:** any esbuild bundle that includes `nedb-engine` must mark it external.

**Why:** bundling rewrites `__dirname` to the output directory, the local
`.node` file is no longer beside it, and startup dies with
`Cannot find module 'nedb-engine-linux-x64-gnu'`. The build succeeds; only the
run fails, so a green build is not evidence the store works.

**How to apply:** when adding a native-binding dependency to an api artifact,
add it to the `external` list in the artifact's `build.mjs`, then restart the
workflow and hit an endpoint that actually touches the store — a build alone
proves nothing here.
