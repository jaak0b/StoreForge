# StoreForge

A browser-based Gridfinity print planner: queue bins by size and label, preview them in 3D, and export a ready-to-slice build plate, all running client-side with no upload.

**[Screenshot: the queue page, showing a few queued bins with labels and the 3D preview pane]**

## Why this exists

Printing a shelf of Gridfinity bins usually means juggling a spreadsheet, a slicer project, and a pile of loose parts you're trying to remember the sizes of. StoreForge keeps the plan, the geometry, and the print outcome in one place: add a bin, see it in 3D immediately, queue a stack of them into one build plate, and check off what actually came out of the printer.

Everything runs in your browser. The 3D geometry (Gridfinity bin bodies, stacking lips, labels) is built with [manifold-3d](https://github.com/elalish/manifold), a WASM constructive solid geometry engine that guarantees watertight, printable meshes. Nothing is uploaded anywhere.

## What you get

- **A queue, not a one-off export.** Add bins by grid size (width x depth x height in Gridfinity units), give each one a label and an optional hardware icon, and keep the whole plan in your browser's local storage. Export/import the plan as JSON to back it up or move it between machines.
- **3D preview per bin**, updated as you edit size, label, and features.
- **STL per bin**, or a full **3MF build plate** for Orca Slicer, with the label on a second filament slot for toolchanger or AMS printing.
- **Print tracking.** After a print session, check off the bins that came out fine; anything that failed stays queued for the next plate.
- **Screw-list import.** Paste a hardware list like `m3x20 fhcs, m5x12 bhcs` and StoreForge parses it into correctly sized, labeled queue entries.
- **Tool tracing.** Photograph an object (a tool, a part) against a sheet of paper, click to segment it, and StoreForge fits a bin around the traced outline, including a measured interior scoop for tools that need a fingertip to reach in.
- **Magnet holes and stacking lip**, generated from the same MIT-licensed reference geometry as `kennetek/gridfinity-rebuilt-openscad` (42 mm pitch, 41.5 mm base footprint, 7 mm height units).

**[Screenshot: the plate/build-plate page with several bins arranged and ready to export]**

**[Screenshot: the tool trace page, mid-trace on a photographed tool]**

## Roadmap

- Import bins from [multibuild.io/multibin](https://multibuild.io/multibin).
- Support non-standard (off-grid) bin sizes alongside the standard Gridfinity units.

## Requirements and limitations

- Runs in a modern desktop browser with WebAssembly and WebGL support (Chrome, Firefox, Edge). No server, no account, no install.
- The plan is stored in your browser's local storage; clearing site data clears your queue. Use the JSON export to keep a backup.
- 3MF export targets Orca Slicer's per-part extruder metadata; other slicers may not read the label's assigned filament slot correctly.
- This is a single-user, local-first tool: there is no cloud sync between browsers or devices.

## Development

Requires Node.js. All commands run inside `web/`:

```bash
npm install
npm run dev     # Vite dev server
npm run build   # typecheck + production build
npm test        # Vitest unit tests
```

Gridfinity bin geometry constants are ported from the MIT-licensed
[kennetek/gridfinity-rebuilt-openscad](https://github.com/kennetek/gridfinity-rebuilt-openscad).

## Contributing

Issues and pull requests are welcome at [github.com/jaak0b/StoreForge](https://github.com/jaak0b/StoreForge).

## License

MIT, see [LICENSE](LICENSE).
