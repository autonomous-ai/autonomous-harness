# Third-party notices

This package installs and serves, unmodified, the following third-party code. Nothing is loaded from a
CDN: the pane serves the npm packages below from this package's own `node_modules`, and RDKit, NumPy
and pandas are installed from PyPI into its own `.venv` (versions in `VERSIONS` and `package-lock.json`).

| Component | Version | Licence | Used for |
|---|---|---|---|
| [3Dmol.js](https://github.com/3dmol/3Dmol.js) (`3dmol`) | 2.5.5 | BSD-3-Clause (`LICENSE-3dmol`); includes code from GLmol, three.js and jQuery | the pane's 3D viewer (`node_modules/3dmol/build/3Dmol-min.js`) |
| [pako](https://github.com/nodeca/pako) | 2.2.0 | MIT and Zlib | dependency of 3Dmol.js (compressed formats) |
| [upng-js](https://github.com/photopea/UPNG.js) | 2.1.0 | MIT | dependency of 3Dmol.js |
| [netcdfjs](https://github.com/cheminfo/netcdfjs) | 3.0.0 | MIT | dependency of 3Dmol.js (trajectory formats) |
| [iobuffer](https://github.com/image-js/iobuffer) | 5.4.0 | MIT | dependency of netcdfjs |
| [RDKit](https://github.com/rdkit/rdkit) | see `VERSIONS` | BSD-3-Clause (`LICENSE-rdkit`) | the chemistry: toolchain and the pane's describe worker |
| [NumPy](https://numpy.org) | see `VERSIONS` | BSD-3-Clause | RDKit and the toolchain |
| [pandas](https://pandas.pydata.org) | see `VERSIONS` | BSD-3-Clause | tables in agent scripts |

The pane's own code (`pane/`, `viewer.mjs`) and the toolchain are this package's, under `LICENSE`.
The PAINS (Baell & Holloway, 2010) and Brenk (Brenk et al., 2008) substructure filters are the
catalogues shipped inside RDKit.
