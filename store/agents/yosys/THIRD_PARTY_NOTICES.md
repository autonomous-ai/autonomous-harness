# Third-party notices

The pane (`viewer.mjs`, `viewer/`) is Autonomous's own code under this package's MIT licence. It
loads nothing from a network and bundles no third-party script into the page. What it uses from
others:

**netlistsvg 1.0.2** — Neil Turley, MIT (`LICENSE-netlistsvg`),
[nturley/netlistsvg](https://github.com/nturley/netlistsvg). Already this package's one npm
dependency (the flow's `svg` step). The pane's server also calls it, unmodified, from
`node_modules` in a worker thread (`viewer/lib/schematic-worker.mjs`) to draw one module of the
hierarchy at a time; the page receives the SVG it returns. The pane restyles the drawing with its
own CSS and reads netlistsvg's default skin (`node_modules/netlistsvg/lib/default.svg`) only to learn
which cell types it has shapes for.

**elkjs 0.3.0** — the Eclipse Layout Kernel compiled to JavaScript, Kiel University and others,
EPL-1.0, [kieler/elkjs](https://github.com/kieler/elkjs). netlistsvg's own dependency, pinned by
`package-lock.json` and installed by `npm ci`; used unmodified, server-side only.

**Project IceStorm chip database** — Claire Xenia Wolf and contributors, ISC (`LICENSE-icestorm`),
[YosysHQ/icestorm](https://github.com/YosysHQ/icestorm). The Board and Chip tabs read the
package-pin table (`.pins <package>`) from the installed `share/icestorm/chipdb/chipdb-*.txt`.
`viewer/lib/chip.mjs` carries the 39-row iCE40UP5K-SG48 table from `chipdb-5k.txt` as a fallback for
a machine where the chipdb cannot be found.

**iCEBreaker pinout** — the pin numbers in `viewer/public/board.js` are the iCEBreaker project's,
from its own constraints file
([icebreaker-fpga/icebreaker-verilog-examples](https://codeberg.org/icebreaker-fpga/icebreaker-verilog-examples/src/branch/main/icebreaker/icebreaker.pcf)),
the same source the template's PCF cites. The board drawing is Autonomous's own schematic
impression, not the board's artwork.

The files the pane reads — VCDs from Icarus Verilog, netlists from Yosys, reports and routed JSON
from nextpnr, `.asc` from the flow — are the user's design, produced by those tools on this machine.
