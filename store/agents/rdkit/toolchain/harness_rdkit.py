"""The few lines every molecule here needs: build it from SMILES, embed its conformers, and write the
files the pane and the verdict read — an SDF with coordinates, a conformer ensemble, a 2D depiction,
the per-atom facts (charges, lipophilicity, groups), the properties, a report and the series index.

    from harness_rdkit import design
    design("CC(C)Cc1ccc(cc1)C(C)C(=O)O", "ibuprofen")                      # the lead
    design("CC(C)(O)Cc1ccc(C(C)C(=O)O)cc1", "ibuprofen_oh", parent="ibuprofen")  # an analogue of it

or the steps by hand, when a molecule needs work in between:

    from harness_rdkit import mol_from_smiles, embed_conformers, write_outputs
    mol = mol_from_smiles("CN1C=NC2=C1C(=O)N(C)C(=O)N2C", "caffeine")
    write_outputs(embed_conformers(mol, n=10, seed=7), "caffeine")

Files, for a molecule `name` in `out/`:

    name.sdf              the lowest-energy conformer (the pane's artifact; opens in PyMOL, ChimeraX)
    name.conformers.sdf   every kept conformer, lowest first, aligned (only when there are several)
    name.svg / name.png   the 2D depiction (the SVG is drawn aligned to the parent's, for a series)
    name.molecule.json    what the pane reads: identifiers, properties, rules, flags, per-atom
                          Gasteiger charge / Crippen logP / hybridisation, functional groups,
                          structural alerts, conformer energies, the parent and what changed
    series.json           every molecule designed here, in order, with its parent
    properties.json       the newest molecule's properties;  report.json  the verdict's input

Also a command line, which is what the pane runs for SDFs that were not written by `write_outputs`:

    python harness_rdkit.py design "SMILES" name [--parent NAME] [--conformers N]
    python harness_rdkit.py describe out/x.sdf        # the molecule.json record, on stdout
    python harness_rdkit.py serve                     # the same, one JSON request per stdin line
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Callable, Iterable

from rdkit import Chem, DataStructs, RDLogger
from rdkit.Chem import AllChem, Crippen, Descriptors, Draw, Lipinski, QED, rdDepictor
from rdkit.Chem import rdCIPLabeler, rdDistGeom, rdFingerprintGenerator, rdFMCS, rdMolAlign, rdMolDescriptors
from rdkit.Chem.Draw import rdMolDraw2D

RDLogger.DisableLog("rdApp.*")  # the parser's chatter is not the agent's business

# Lipinski's rule of five and Veber's two: the tests, and the threshold each one fails at.
RULE_OF_FIVE = (("mw", 500.0), ("logp", 5.0), ("hbd", 5.0), ("hba", 10.0))
VEBER = (("rotatable_bonds", 10.0), ("tpsa", 140.0))
SERIES = "series.json"
PROGRESS = ".progress.json"
SIMILAR_ENOUGH = 0.35  # below this Tanimoto an earlier molecule is not taken for the parent

# Functional groups, most specific first. An atom that is the heteroatom of one group is not counted
# again for a vaguer one (the OH of an acid is not also an alcohol).
GROUPS = (  # atoms mapped `:1` are the group itself; the rest only give it context
    ("Carboxylic acid", "[CX3:1](=[O:1])[OX2H1:1]"),
    ("Carboxylate", "[CX3:1](=[O:1])[OX1-:1]"),
    ("Acyl sulfonamide", "[CX3:1](=[O:1])[NX3:1][SX4:1](=[O:1])=[O:1]"),
    ("Sulfonamide", "[SX4:1](=[OX1:1])(=[OX1:1])[NX3:1]"),
    ("Sulfone", "[#6][SX4:1](=[OX1:1])(=[OX1:1])[#6]"),
    ("Urea", "[NX3:1][CX3:1](=[OX1:1])[NX3:1]"),
    ("Carbamate", "[NX3:1][CX3:1](=[OX1:1])[OX2:1][#6]"),
    ("Ester", "[#6][CX3:1](=[O:1])[OX2H0:1][#6]"),
    ("Lactam", "[NX3;R:1][CX3;R:1](=[OX1:1])[#6]"),
    ("Amide", "[NX3:1][CX3:1](=[OX1:1])[#6]"),
    ("Aldehyde", "[CX3H1:1](=[O:1])[#6]"),
    ("Ketone", "[#6][CX3:1](=[O:1])[#6]"),
    ("Nitrile", "[NX1:1]#[CX2:1]"),
    ("Nitro", "[$([NX3](=O)=O),$([NX3+](=O)[O-]):1](~[O:1])~[O:1]"),
    ("Phenol", "[OX2H:1][c:1]"),
    ("Tertiary alcohol", "[OX2H:1][CX4:1]([#6])([#6])[#6]"),
    ("Secondary alcohol", "[OX2H:1][CX4H1:1]([#6])[#6]"),
    ("Primary alcohol", "[OX2H:1][CX4H2:1]"),
    ("Aryl ether", "[OD2:1]([c])[#6]"),
    ("Ether", "[OD2:1]([#6])[#6]"),
    ("Aniline", "[NX3;H2,H1;!$(NC=[O,S,N]);!$(N[S,P]=O):1]c"),
    ("Primary amine", "[NX3;H2;!$(NC=[O,S,N]);!$(N[a]);!$(N[S,P]=O):1][CX4]"),
    ("Secondary amine", "[NX3;H1;!$(NC=[O,S,N]);!$(N[a]);!$(N[S,P]=O):1]([CX4])[CX4]"),
    ("Tertiary amine", "[NX3;H0;!$(NC=[O,S,N]);!$(N[a]);!$(N[S,P]=O):1]([CX4])([CX4])[CX4]"),
    ("Trifluoromethyl", "[CX4:1]([F:1])([F:1])[F:1]"),
    ("Aryl halide", "[F,Cl,Br,I:1][c]"),
    ("Alkyl halide", "[F,Cl,Br,I:1][CX4]"),
    ("Thiol", "[SX2H:1]"),
    ("Thioether", "[SX2:1]([#6])[#6]"),
    ("Alkyne", "[CX2:1]#[CX2:1]"),
    ("Michael acceptor", "[CX3:1]=[CX3:1][CX3:1]=[O:1]"),
)
AROMATIC_RINGS = (  # SMARTS: a lowercase n is any aromatic nitrogen, substituted or not
    ("Indole", "c1ccc2nccc2c1"), ("Benzimidazole", "c1ccc2ncnc2c1"), ("Quinoline", "c1ccc2ncccc2c1"),
    ("Naphthalene", "c1ccc2ccccc2c1"), ("Purine", "c1ncc2ncnc2n1"), ("Pyrimidine", "c1cncnc1"), ("Pyrazine", "c1cnccn1"),
    ("Pyridine", "c1ccncc1"), ("Tetrazole", "c1nnnn1"), ("Triazole", "c1cnnn1"), ("Triazole", "c1ncnn1"), ("Imidazole", "c1cncn1"),
    ("Pyrazole", "c1ccnn1"), ("Oxazole", "c1cocn1"), ("Thiazole", "c1cscn1"), ("Isoxazole", "c1conc1"),
    ("Thiophene", "c1ccsc1"), ("Furan", "c1ccoc1"), ("Pyrrole", "c1ccnc1"), ("Benzene ring", "c1ccccc1"),
)
_PATTERNS: dict[str, Chem.Mol] = {}
_CATALOG = None


def _as_mol(value: "str | Chem.Mol") -> Chem.Mol:
    return mol_from_smiles(value) if isinstance(value, str) else value


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _write(path: Path, data: "str | bytes") -> None:
    """Write through a hidden temporary and a rename, so the pane never reads half a file."""
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_bytes(data.encode() if isinstance(data, str) else data)
    os.replace(tmp, path)


def _pattern(smarts: str) -> Chem.Mol:
    if smarts not in _PATTERNS:
        _PATTERNS[smarts] = Chem.MolFromSmarts(smarts)
    return _PATTERNS[smarts]


def progress(out: "str | Path", name: str, stage: str, detail: str | None = None) -> None:
    """Tell the pane what is happening (`embedding`, `minimising`, `describing`, `writing`, `done`)."""
    try:
        out = Path(out)
        out.mkdir(parents=True, exist_ok=True)
        _write(out / PROGRESS, json.dumps({"name": name, "stage": stage, "detail": detail, "pid": os.getpid(),
                                           "at": time.time()}) + "\n")
    except OSError:
        pass


def mol_from_smiles(smiles: str, name: str | None = None) -> Chem.Mol:
    """A sanitized molecule from SMILES. Raises with the string when RDKit cannot read it — a bad
    valence or an unclosed ring is a typo in the SMILES, not something to work around."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError(f"not a valid SMILES: {smiles!r}")
    mol.SetProp("_Name", name or smiles)
    return mol


def embed_3d(mol: Chem.Mol, seed: int = 7, max_iters: int = 1000) -> Chem.Mol:
    """One 3D conformer: explicit hydrogens, ETKDGv3 distance geometry at a fixed seed, then an MMFF94
    minimisation (UFF when MMFF has no parameters for an atom). Returns a NEW molecule with the
    hydrogens and the conformer on it, carrying `forcefield`, `energy_before` and `energy` properties."""
    molh = Chem.AddHs(mol)
    params = rdDistGeom.ETKDGv3()
    params.randomSeed = seed
    if rdDistGeom.EmbedMolecule(molh, params) != 0:
        params.useRandomCoords = True  # cages and macrocycles need the fallback
        if rdDistGeom.EmbedMolecule(molh, params) != 0:
            raise RuntimeError(f"no 3D embedding for {Chem.MolToSmiles(mol)} — try another seed")
    field, before, after = _minimise(molh, max_iters)
    molh.SetProp("_Name", mol.GetProp("_Name") if mol.HasProp("_Name") else Chem.MolToSmiles(mol))
    molh.SetProp("forcefield", field)
    molh.SetDoubleProp("energy_before", before)
    molh.SetDoubleProp("energy", after)
    molh.SetProp("conformer_energies", json.dumps([round(after, 4)]))
    return molh


def _forcefield(mol: Chem.Mol, conf_id: int = -1):
    if AllChem.MMFFHasAllMoleculeParams(mol):
        return "MMFF94", AllChem.MMFFGetMoleculeForceField(mol, AllChem.MMFFGetMoleculeProperties(mol), confId=conf_id)
    return "UFF", AllChem.UFFGetMoleculeForceField(mol, confId=conf_id)


def _minimise(mol: Chem.Mol, max_iters: int) -> tuple[str, float, float]:
    field, ff = _forcefield(mol)
    before = float(ff.CalcEnergy())
    ff.Minimize(maxIts=max_iters)
    return field, before, float(ff.CalcEnergy())


def embed_conformers(mol: Chem.Mol, n: int = 10, seed: int = 7, max_iters: int = 2000, prune_rms: float = 0.25,
                     window: float = 10.0, on_stage: Callable[[str, str], None] | None = None) -> Chem.Mol:
    """A small conformer search: ETKDGv3 embeds (pruned at `prune_rms` Å), each minimised with MMFF94
    (UFF as the fallback), duplicate minima dropped (symmetry-aware heavy-atom RMS under 0.3 Å), the
    `n` lowest within `window` kcal/mol kept in energy order and aligned on the first. Returns a NEW molecule with hydrogens whose conformer 0 is the global minimum found, with
    `forcefield`, `energy` (the lowest), `energy_before` and `conformer_energies` (JSON) properties.
    Deterministic for a given seed. `n=1` is `embed_3d`."""
    if n <= 1:
        return embed_3d(mol, seed=seed)
    stage = on_stage or (lambda *_: None)
    molh = Chem.AddHs(mol)
    unspecified = _pin_stereo(molh, seed)
    params = rdDistGeom.ETKDGv3()
    params.randomSeed = seed
    params.pruneRmsThresh = prune_rms
    params.numThreads = 0
    attempts = max(3 * n, 30)
    stage("embedding", f"{attempts} attempts")
    cids = list(rdDistGeom.EmbedMultipleConfs(molh, numConfs=attempts, params=params))
    if not cids:
        params.useRandomCoords = True
        cids = list(rdDistGeom.EmbedMultipleConfs(molh, numConfs=attempts, params=params))
    if not cids:
        raise RuntimeError(f"no 3D embedding for {Chem.MolToSmiles(mol)} — try another seed")
    field, _ = _forcefield(molh, cids[0])
    before = {cid: float(_forcefield(molh, cid)[1].CalcEnergy()) for cid in cids}
    stage("minimising", f"{len(cids)} embeddings · {field}")
    if field == "MMFF94":
        results = AllChem.MMFFOptimizeMoleculeConfs(molh, numThreads=0, maxIters=max_iters)
    else:
        results = AllChem.UFFOptimizeMoleculeConfs(molh, numThreads=0, maxIters=max_iters)
    energies = {cid: float(results[k][1]) for k, cid in enumerate(cids)}
    heavy = [a.GetIdx() for a in molh.GetAtoms() if a.GetAtomicNum() > 1]
    skeleton = Chem.RemoveHs(molh)  # symmetry-aware RMS on heavy atoms: a flipped ring is the same minimum
    lowest = min(energies.values())
    kept: list[int] = []
    for cid in sorted(cids, key=lambda c: energies[c]):
        if len(kept) >= n or energies[cid] - lowest > window:
            break
        if any(abs(energies[cid] - energies[k]) < 1.0 and _best_rms(skeleton, cid, k) < 0.3 for k in kept):
            continue
        kept.append(cid)
    out = Chem.Mol(molh)
    out.RemoveAllConformers()
    for new_id, cid in enumerate(kept):
        conf = Chem.Conformer(molh.GetConformer(cid))
        conf.SetId(new_id)
        out.AddConformer(conf, assignId=False)
    if len(kept) > 1:
        rdMolAlign.AlignMolConformers(out, atomIds=heavy)
    out.SetProp("_Name", mol.GetProp("_Name") if mol.HasProp("_Name") else Chem.MolToSmiles(mol))
    out.SetProp("forcefield", field)
    out.SetDoubleProp("energy_before", before[kept[0]])
    out.SetDoubleProp("energy", energies[kept[0]])
    out.SetProp("conformer_energies", json.dumps([round(energies[c], 4) for c in kept]))
    if unspecified:
        out.SetProp("unspecified_stereo", json.dumps(unspecified))
    return out


def _best_rms(skeleton: Chem.Mol, a: int, b: int) -> float:
    try:
        return rdMolAlign.GetBestRMS(Chem.Mol(skeleton), skeleton, prbId=a, refId=b, maxMatches=2000)
    except RuntimeError:
        return AllChem.GetConformerRMS(Chem.Mol(skeleton), b, a)


def _pin_stereo(molh: Chem.Mol, seed: int) -> list[int]:
    """An unspecified stereocentre would embed as R in one conformer and S in the next, and stepping
    through the ensemble would invert it. Pin each to what one embedding at `seed` chose, and return
    their indices so the record can still say they were never specified."""
    unspecified = [i for i, label in _stereocentres(molh) if label == "?"]
    if not unspecified:
        return []
    probe = Chem.Mol(molh)
    params = rdDistGeom.ETKDGv3()
    params.randomSeed = seed
    if rdDistGeom.EmbedMolecule(probe, params) != 0:
        return unspecified
    Chem.AssignStereochemistryFrom3D(probe)
    for i in unspecified:
        molh.GetAtomWithIdx(i).SetChiralTag(probe.GetAtomWithIdx(i).GetChiralTag())
    Chem.AssignStereochemistry(molh, cleanIt=True, force=True)
    return unspecified


def _stereocentres(flat: Chem.Mol) -> list[tuple[int, str]]:
    try:
        return Chem.FindMolChiralCenters(flat, includeUnassigned=True, useLegacyImplementation=False)
    except RuntimeError:  # the new CIP labeller refuses odd valences (a PDB read without bond orders)
        return Chem.FindMolChiralCenters(flat, includeUnassigned=True, useLegacyImplementation=True)


def properties(mol: Chem.Mol) -> dict:
    """The numbers a medicinal chemist asks for first, on the molecule without its hydrogens."""
    flat = Chem.RemoveHs(mol)
    centres = _stereocentres(flat)
    values = {
        "formula": rdMolDescriptors.CalcMolFormula(flat),
        "smiles": Chem.MolToSmiles(flat),
        "mw": round(Descriptors.MolWt(flat), 2),
        "logp": round(Crippen.MolLogP(flat), 2),
        "tpsa": round(rdMolDescriptors.CalcTPSA(flat), 2),
        "hbd": Lipinski.NumHDonors(flat),
        "hba": Lipinski.NumHAcceptors(flat),
        "rotatable_bonds": Lipinski.NumRotatableBonds(flat),
        "rings": rdMolDescriptors.CalcNumRings(flat),
        "heavy_atoms": flat.GetNumHeavyAtoms(),
        "qed": round(QED.qed(flat), 3),
        "aromatic_rings": rdMolDescriptors.CalcNumAromaticRings(flat),
        "formal_charge": Chem.GetFormalCharge(flat),
        "fsp3": round(rdMolDescriptors.CalcFractionCSP3(flat), 2),
        "mr": round(Crippen.MolMR(flat), 2),
        "exact_mass": round(Descriptors.ExactMolWt(flat), 4),
        "stereocenters": len(centres),
        "unspecified_stereocenters": sum(1 for _, label in centres if label == "?"),
    }
    violations = [f"{key} {values[key]} > {limit:g}" for key, limit in RULE_OF_FIVE if values[key] > limit]
    veber = [f"{key} {values[key]} > {limit:g}" for key, limit in VEBER if values[key] > limit]
    return {**values, "lipinski_violations": len(violations), "lipinski": violations,
            "veber_violations": len(veber), "veber": veber}


def functional_groups(mol: Chem.Mol) -> list[dict]:
    """Named groups and aromatic rings, as `{"name", "atoms"}` with atom indices of `mol`."""
    flat = mol
    claimed: set[int] = set()
    found: list[dict] = []
    for name, smarts in GROUPS:
        query = _pattern(smarts)
        core = [k for k, atom in enumerate(query.GetAtoms()) if atom.GetAtomMapNum()] or list(range(query.GetNumAtoms()))
        for match in flat.GetSubstructMatches(query):
            atoms = sorted({match[k] for k in core})
            hetero = {i for i in atoms if flat.GetAtomWithIdx(i).GetAtomicNum() not in (1, 6)}
            if hetero & claimed:
                continue
            claimed |= hetero
            found.append({"name": name, "atoms": atoms})
    ring_atoms: list[set[int]] = []
    for name, smarts in AROMATIC_RINGS:
        for match in flat.GetSubstructMatches(_pattern(smarts)):
            atoms = set(match)
            if any(atoms <= seen for seen in ring_atoms):
                continue
            ring_atoms.append(atoms)
            found.append({"name": name, "atoms": sorted(atoms)})
    for ring in flat.GetRingInfo().AtomRings():
        atoms = set(ring)
        if all(flat.GetAtomWithIdx(i).GetIsAromatic() for i in ring) and not any(atoms <= seen for seen in ring_atoms):
            ring_atoms.append(atoms)
            found.append({"name": "Aromatic ring", "atoms": sorted(atoms)})
    return found


def structural_alerts(mol: Chem.Mol) -> list[dict]:
    """PAINS and Brenk substructure alerts, as `{"catalog", "name", "atoms"}`. Alerts are reasons to
    look twice, not verdicts."""
    global _CATALOG
    from rdkit.Chem.FilterCatalog import FilterCatalog, FilterCatalogParams
    if _CATALOG is None:
        params = FilterCatalogParams()
        params.AddCatalog(FilterCatalogParams.FilterCatalogs.PAINS)
        params.AddCatalog(FilterCatalogParams.FilterCatalogs.BRENK)
        _CATALOG = FilterCatalog(params)
    alerts = []
    for entry in _CATALOG.GetMatches(mol):
        keys = list(entry.GetPropList())
        catalog = "Brenk" if "brenk" in (entry.GetProp("FilterSet") if "FilterSet" in keys else "").lower() else "PAINS"
        atoms = sorted({pair[1] for fm in entry.GetFilterMatches(mol) for pair in fm.atomPairs})
        name = re.sub(r"\(\d+\)$", "", entry.GetDescription()).replace("_", " ").strip()
        alerts.append({"catalog": catalog, "name": name[:1].upper() + name[1:], "atoms": atoms})
    return alerts


def depict(mol: Chem.Mol, path: str | Path, size: tuple[int, int] = (600, 400)) -> Path:
    """The flat picture, as a 600×400 PNG: 2D coordinates, stereo annotated."""
    flat = Chem.RemoveHs(Chem.Mol(mol))
    rdDepictor.Compute2DCoords(flat)
    path = Path(path)
    try:
        drawer = rdMolDraw2D.MolDraw2DCairo(*size)
        drawer.drawOptions().addStereoAnnotation = True
        rdMolDraw2D.PrepareAndDrawMolecule(drawer, flat)
        drawer.FinishDrawing()
        path.write_bytes(drawer.GetDrawingText())
    except Exception:  # a build without Cairo still has the Pillow renderer
        Draw.MolToFile(flat, str(path), size=size)
    return path


def _draw_svg(flat: Chem.Mol, bond_px: float = 32.0) -> tuple[str, list[tuple[float, float]], tuple[int, int]]:
    """The depiction as an SVG sized to the molecule (a flexible canvas at `bond_px` per bond), so a
    series draws at one scale and a thumbnail is not mostly margin. Returns the SVG, each atom's
    position in it, and its size."""
    conf = flat.GetConformer()
    lengths = sorted((conf.GetAtomPosition(b.GetBeginAtomIdx()) - conf.GetAtomPosition(b.GetEndAtomIdx())).Length()
                     for b in flat.GetBonds())
    unit = lengths[len(lengths) // 2] if lengths and lengths[len(lengths) // 2] > 1e-3 else 1.0
    drawer = rdMolDraw2D.MolDraw2DSVG(-1, -1)
    options = drawer.drawOptions()
    options.scalingFactor = bond_px / unit
    options.clearBackground = False
    options.addStereoAnnotation = True
    options.bondLineWidth = 2
    options.padding = 0.06
    options.minFontSize = 13
    options.annotationFontScale = 0.7
    rdMolDraw2D.PrepareAndDrawMolecule(drawer, flat)
    drawer.FinishDrawing()
    coords = [tuple(round(v, 1) for v in drawer.GetDrawCoords(i)) for i in range(flat.GetNumAtoms())]
    return drawer.GetDrawingText(), coords, (drawer.Width(), drawer.Height())


def _flat_with_map(mol: Chem.Mol) -> tuple[Chem.Mol, list[int]]:
    """The molecule without hydrogens, and for each of its atoms the index in `mol` (the 3D model)."""
    tagged = Chem.Mol(mol)
    for atom in tagged.GetAtoms():
        atom.SetIntProp("__i3d", atom.GetIdx())
    flat = Chem.RemoveHs(tagged, sanitize=True)
    return flat, [a.GetIntProp("__i3d") for a in flat.GetAtoms()]


def _formula_delta(child: str, parent: str) -> str:
    def counts(formula: str) -> Counter:
        c: Counter = Counter()
        for element, n in re.findall(r"([A-Z][a-z]?)(\d*)", formula.split("+")[0].split("-")[0]):
            c[element] += int(n or 1)
        return c
    a, b = counts(child), counts(parent)
    heavy = [e for e in set(a) | set(b) if e != "H" and a[e] != b[e]]
    parts = []
    for element in sorted(heavy or ([e for e in ("H",) if a[e] != b[e]]), key=lambda e: (e != "C", e)):
        d = a[element] - b[element]
        parts.append(f"{'+' if d > 0 else '−'}{abs(d) if abs(d) > 1 else ''}{element}")
    return " ".join(parts) or "isomer"


# ---- the series: every molecule designed in an out/ folder, in order ------------------------------

def read_series(out: "str | Path" = "out/") -> dict:
    """`out/series.json`, or — for a folder written before it existed — one built from its SDFs."""
    out = Path(out)
    try:
        data = json.loads((out / SERIES).read_text())
        if isinstance(data, dict) and isinstance(data.get("molecules"), list):
            return data
    except (OSError, ValueError):
        pass
    molecules = []
    for sdf in sorted(_sdfs(out), key=lambda p: p.stat().st_mtime):
        mol = _read_first(sdf)
        if mol is None:
            continue
        flat = Chem.RemoveHs(mol)
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(sdf.stat().st_mtime))
        molecules.append({"name": sdf.stem, "smiles": Chem.MolToSmiles(flat), "formula": rdMolDescriptors.CalcMolFormula(flat),
                          "sdf": sdf.name, "parent": None, "createdAt": stamp, "updatedAt": stamp, "legacy": True})
    return {"spec": "rdkit-series/1", "molecules": molecules}


def _sdfs(out: Path) -> list[Path]:
    return [p for p in out.glob("*.sdf") if p.is_file() and not p.name.endswith(".conformers.sdf") and not p.name.startswith(".")]


def _read_first(path: Path) -> Chem.Mol | None:
    try:
        for mol in Chem.SDMolSupplier(str(path), removeHs=False):
            if mol is not None:
                return mol
    except OSError:
        return None
    return None


def _infer_parent(name: str, flat: Chem.Mol, series: dict) -> tuple[dict | None, float]:
    """The molecule designed before this one that it is the smallest edit of: of the five most similar
    earlier molecules (Morgan Tanimoto ≥ 0.35), the one sharing the largest maximum common substructure
    relative to both sizes (at least half of the atoms of the two together). An analogue of a lead is its
    lead's child, not its sibling's."""
    earlier = []
    for entry in series.get("molecules", []):
        if entry.get("name") == name:
            break
        earlier.append(entry)
    scored = []
    for order, entry in enumerate(earlier):
        if entry.get("parent") == name or not entry.get("smiles"):
            continue
        other = Chem.MolFromSmiles(entry["smiles"])
        if other is None:
            continue
        s = similarity(flat, other)
        if s >= SIMILAR_ENOUGH:
            scored.append((s, order, entry, other))
    best, best_key = None, None
    for s, order, entry, other in sorted(scored, key=lambda t: -t[0])[:5]:
        shared = _mcs(other, flat).numAtoms
        overlap = shared / max(1, flat.GetNumAtoms() + other.GetNumAtoms() - shared)
        if overlap < 0.5:  # sharing a fragment is not being an analogue
            continue
        key = (round(overlap, 6), round(s, 6), -order)
        if best_key is None or key > best_key:
            best, best_key = (entry, s), key
    return best if best else (None, 0.0)


def _mcs(a: Chem.Mol, b: Chem.Mol):
    """The maximum common substructure by topology — any atom matches any atom, bond orders must agree
    — so a CH2→O swap is one changed atom, not a broken scaffold."""
    return rdFMCS.FindMCS([a, b], timeout=2, ringMatchesRingOnly=True, completeRingsOnly=True,
                          atomCompare=rdFMCS.AtomCompare.CompareAny, bondCompare=rdFMCS.BondCompare.CompareOrder)


def _parent_template(entry: dict, out: Path) -> tuple[Chem.Mol | None, list[int], dict | None]:
    """The parent as the depiction and the 3D overlay see it: its flat molecule (from its SDF when there
    is one, so indices match the pane's model), the flat→3D index map, and its record."""
    record = None
    json_path = out / f"{entry['name']}.molecule.json"
    try:
        record = json.loads(json_path.read_text())
    except (OSError, ValueError):
        record = None
    sdf = out / (entry.get("sdf") or f"{entry['name']}.sdf")
    mol = _read_first(sdf) if sdf.exists() else None
    if mol is not None:
        flat, to3d = _flat_with_map(mol)
    else:
        flat = mol_from_smiles(entry["smiles"], entry["name"])
        to3d = list(range(flat.GetNumAtoms()))
    return flat, to3d, record


def _relation(flat: Chem.Mol, to3d: list[int], name: str, parent, out: Path, series: dict) -> tuple[dict | None, Chem.Mol | None, Chem.Mol | None]:
    """Resolve the parent (a name in the series, a SMILES, or None to infer it), then what is shared
    (the maximum common substructure) and what changed. Returns the record, the parent's 2D template
    and the MCS query for the aligned depiction."""
    if parent is False:
        return None, None, None
    inferred = parent is None
    entry = None
    score = None
    if parent is None:
        entry, score = _infer_parent(name, flat, series)
        if entry is None:
            return None, None, None
    elif isinstance(parent, str):
        entry = next((m for m in series.get("molecules", []) if m.get("name") == parent), None)
        if entry is None:
            pmol = Chem.MolFromSmiles(parent)
            if pmol is None:
                raise ValueError(f"parent {parent!r} is neither a molecule in {out / SERIES} nor a SMILES")
            canonical = Chem.MolToSmiles(pmol)
            entry = next((m for m in series.get("molecules", []) if m.get("smiles") == canonical),
                         {"name": parent if len(parent) < 40 else "parent", "smiles": canonical})
    elif isinstance(parent, Chem.Mol):
        p = Chem.RemoveHs(parent)
        entry = {"name": parent.GetProp("_Name") if parent.HasProp("_Name") else "parent", "smiles": Chem.MolToSmiles(p)}
    if entry is None or entry.get("name") == name:
        return None, None, None
    pflat, pto3d, precord = _parent_template(entry, out)
    if score is None:
        score = similarity(flat, pflat)
    mcs = _mcs(pflat, flat)
    query = Chem.MolFromSmarts(mcs.smartsString) if mcs.numAtoms else None
    pairs: list[tuple[int, int]] = []
    if query is not None:
        pm, cm = pflat.GetSubstructMatch(query), flat.GetSubstructMatch(query)
        if pm and cm:
            pairs = list(zip(cm, pm))
    same = {c for c, p in pairs if flat.GetAtomWithIdx(c).GetAtomicNum() == pflat.GetAtomWithIdx(p).GetAtomicNum()}
    changed = [i for i in range(flat.GetNumAtoms()) if i not in same]
    attachment = sorted({c for c in same for nb in flat.GetAtomWithIdx(c).GetNeighbors() if nb.GetIdx() in changed})
    matched = {p for _, p in pairs}
    removed = [p for p in range(pflat.GetNumAtoms()) if p not in matched]
    mine, theirs = properties(flat), properties(pflat)
    deltas = {k: round(mine[k] - theirs[k], 3) for k in ("mw", "logp", "tpsa", "hbd", "hba", "rotatable_bonds", "qed", "fsp3")}
    record = {
        "name": entry["name"], "smiles": entry.get("smiles") or Chem.MolToSmiles(pflat), "inferred": inferred,
        "sdf": entry.get("sdf") if (out / (entry.get("sdf") or "-")).exists() else None,
        "similarity": round(score, 3), "shared_atoms": len(pairs), "removed_atoms": len(removed),
        "change": _formula_delta(mine["formula"], theirs["formula"]),
        "map": [[to3d[c], pto3d[p]] for c, p in pairs],
        "changed": [to3d[i] for i in changed], "attachment": [to3d[i] for i in attachment],
        "removed": [pto3d[i] for i in removed],  # the parent's atoms with no counterpart here
        "properties": {k: theirs[k] for k in ("formula", "mw", "logp", "tpsa", "hbd", "hba", "rotatable_bonds", "qed", "fsp3")},
        "deltas": deltas,
    }
    template = None
    if query is not None and pairs:
        template = Chem.Mol(pflat)
        coords = {}
        for item in ((precord or {}).get("depiction") or {}).get("atoms") or []:
            if len(item) >= 5:
                coords[item[0]] = (item[3], item[4])
        if coords and all(pto3d[i] in coords for i in range(template.GetNumAtoms())):
            conf = Chem.Conformer(template.GetNumAtoms())
            for i in range(template.GetNumAtoms()):
                x, y = coords[pto3d[i]]
                conf.SetAtomPosition(i, (x, y, 0.0))
            template.RemoveAllConformers()
            template.AddConformer(conf, assignId=True)
        else:
            rdDepictor.Compute2DCoords(template)
    return record, template, query


def _flags(props: dict, groups: list[dict], alerts: list[dict], centres: list[tuple[int, str]], geometry: dict[int, str]) -> list[dict]:
    """The numbers in plain language. `good`, `note` or `warn`; never a claim about activity."""
    flags = []
    n = props["lipinski_violations"]
    if n == 0:
        flags.append({"level": "good", "text": "Passes Lipinski's rule of five (MW ≤ 500, cLogP ≤ 5, HBD ≤ 5, HBA ≤ 10)."})
    elif n == 1:
        flags.append({"level": "note", "text": f"One Lipinski violation ({props['lipinski'][0]}) — still inside the rule, which allows one."})
    else:
        flags.append({"level": "warn", "text": f"{n} Lipinski violations — oral absorption is less likely by this rule of thumb."})
    if props["veber_violations"]:
        flags.append({"level": "warn", "text": f"Fails Veber ({', '.join(props['veber'])}) — flexible or polar molecules are often poorly bioavailable."})
    else:
        flags.append({"level": "good", "text": "Passes Veber (≤ 10 rotatable bonds, TPSA ≤ 140 Å²)."})
    logp, tpsa = props["logp"], props["tpsa"]
    if logp > 5:
        flags.append({"level": "warn", "text": f"cLogP {logp:g} is very lipophilic — expect solubility, metabolism and promiscuity risks."})
    elif logp > 3:
        flags.append({"level": "note", "text": f"cLogP {logp:g} is on the lipophilic side of the usual 1–3 sweet spot."})
    elif logp < 0:
        flags.append({"level": "note", "text": f"cLogP {logp:g} is polar — passive permeability may be limited."})
    else:
        flags.append({"level": "good", "text": f"cLogP {logp:g} sits in the 0–3 range most oral drugs occupy."})
    if tpsa <= 90:
        flags.append({"level": "good", "text": f"TPSA {tpsa:g} Å² is under 90 — compatible with brain penetration as well as oral absorption."})
    elif tpsa <= 140:
        flags.append({"level": "note", "text": f"TPSA {tpsa:g} Å² suits oral absorption, but is above the ~90 Å² usually seen for CNS drugs."})
    else:
        flags.append({"level": "warn", "text": f"TPSA {tpsa:g} Å² is above 140 — poor membrane permeability is likely."})
    qed = props["qed"]
    if qed >= 0.67:
        flags.append({"level": "good", "text": f"QED {qed:g} — attractive by the 2012 drug-likeness score (≥ 0.67)."})
    elif qed < 0.35:
        flags.append({"level": "warn", "text": f"QED {qed:g} — unattractive by the drug-likeness score (< 0.35)."})
    names = {g["name"] for g in groups}
    if names & {"Carboxylic acid", "Acyl sulfonamide", "Tetrazole"}:
        flags.append({"level": "note", "text": "Acidic group — mostly ionised at pH 7.4, so logD will be well below the cLogP of the neutral form."})
    if names & {"Primary amine", "Secondary amine", "Tertiary amine"}:
        flags.append({"level": "note", "text": "Basic amine — mostly protonated at pH 7.4; cLogP describes the neutral form."})
    unspecified = [i for i, label in centres if label == "?"]
    if unspecified:
        shown = ", ".join(f"{geometry.get(i, '?')}" for i in unspecified)
        flags.append({"level": "warn", "text": f"{len(unspecified)} stereocentre{'s' if len(unspecified) > 1 else ''} unspecified in the SMILES — the 3D model shows one arbitrary configuration ({shown})."})
    if props["formal_charge"]:
        flags.append({"level": "note", "text": f"Net formal charge {props['formal_charge']:+d}."})
    if props["fsp3"] < 0.25 and props["aromatic_rings"] >= 2:
        flags.append({"level": "note", "text": f"Flat and aromatic-rich (Fsp3 {props['fsp3']:g}, {props['aromatic_rings']} aromatic rings) — solubility tends to suffer."})
    for alert in alerts:
        flags.append({"level": "warn", "text": f"{alert['catalog']} alert: {alert['name']} — a substructure worth a second look."})
    return flags


def describe(mol: Chem.Mol, name: str | None = None, *, parent=None, out: "str | Path" = "out/",
             series: dict | None = None) -> tuple[dict, str]:
    """Everything the pane shows about one molecule, as (record, svg). Atom indices are those of `mol`
    (hydrogens included), which is the order of its SDF. Pure: writes nothing."""
    out = Path(out)
    name = name or (mol.GetProp("_Name") if mol.HasProp("_Name") else "molecule")
    series = series if series is not None else read_series(out)
    flat, to3d = _flat_with_map(mol)
    props = properties(mol)
    pinned = set(json.loads(mol.GetProp("unspecified_stereo"))) if mol.HasProp("unspecified_stereo") else set()
    as_written = Chem.Mol(flat)  # the identity is the molecule as specified, not the enantiomer embedded
    for f, i3 in enumerate(to3d):
        if i3 in pinned:
            as_written.GetAtomWithIdx(f).SetChiralTag(Chem.ChiralType.CHI_UNSPECIFIED)
    if pinned:
        as_written.RemoveAllConformers()  # InChI reads stereo from coordinates too
        Chem.AssignStereochemistry(as_written, cleanIt=True, force=True)
        props["smiles"] = Chem.MolToSmiles(as_written)
    try:
        inchi = Chem.MolToInchi(as_written)
        inchikey = Chem.InchiToInchiKey(inchi) if inchi else None
    except Exception:
        inchi, inchikey = None, None

    charged = Chem.Mol(mol)
    AllChem.ComputeGasteigerCharges(charged)
    crippen = rdMolDescriptors._CalcCrippenContribs(mol)
    tpsa = rdMolDescriptors._CalcTPSAContribs(flat)
    geometry: dict[int, str] = {}
    if mol.GetNumConformers() and mol.GetConformer().Is3D():
        solid = Chem.Mol(mol)
        Chem.AssignStereochemistryFrom3D(solid)
        try:
            rdCIPLabeler.AssignCIPLabels(solid)
        except RuntimeError:  # an unusual valence (a PDB without bond orders): the legacy labels will do
            pass
        geometry = {a.GetIdx(): a.GetProp("_CIPCode") for a in solid.GetAtoms() if a.HasProp("_CIPCode")}
    centres = [(to3d[i], "?" if to3d[i] in pinned else label) for i, label in _stereocentres(flat)]
    props["unspecified_stereocenters"] = sum(1 for _, label in centres if label == "?")
    heavy_of = {}
    for atom in mol.GetAtoms():
        if atom.GetAtomicNum() == 1 and atom.GetDegree():
            heavy_of[atom.GetIdx()] = atom.GetNeighbors()[0].GetIdx()
    flat_of = {i3: f for f, i3 in enumerate(to3d)}
    ring = mol.GetRingInfo()
    atoms = []
    for atom in mol.GetAtoms():
        i = atom.GetIdx()
        q = charged.GetAtomWithIdx(i).GetDoubleProp("_GasteigerCharge") if charged.GetAtomWithIdx(i).HasProp("_GasteigerCharge") else float("nan")
        atoms.append({
            "i": i, "el": atom.GetSymbol(),
            "q": round(q, 4) if math.isfinite(q) else None,
            "logp": round(crippen[i][0], 3) if i < len(crippen) else None,
            "tpsa": round(tpsa[flat_of[i]], 2) if i in flat_of and tpsa[flat_of[i]] else 0,
            "hyb": str(atom.GetHybridization()).lower().replace("unspecified", "") or None,
            "arom": atom.GetIsAromatic(), "ring": ring.NumAtomRings(i) > 0, "fc": atom.GetFormalCharge(),
            "h": atom.GetTotalNumHs(includeNeighbors=True), "on": heavy_of.get(i), "cip": geometry.get(i),
        })

    groups = [{"name": g["name"], "atoms": [to3d[i] for i in g["atoms"]]} for g in functional_groups(flat)]
    alerts = [{**a, "atoms": [to3d[i] for i in a["atoms"]]} for a in structural_alerts(flat)]
    relation, template, query = _relation(flat, to3d, name, parent, out, series)

    rdDepictor.SetPreferCoordGen(True)
    depicted = Chem.Mol(flat)
    aligned = False
    if template is not None and query is not None:
        try:
            rdDepictor.GenerateDepictionMatching2DStructure(depicted, template, refPatt=query, acceptFailure=False)
            aligned = True
        except Exception:
            rdDepictor.Compute2DCoords(depicted)
    else:
        rdDepictor.Compute2DCoords(depicted)
    svg, drawn, size = _draw_svg(depicted)
    pos = depicted.GetConformer()
    depiction = {
        "width": size[0], "height": size[1], "aligned_to_parent": aligned,
        # [3D index, x px, y px, x 2D, y 2D] per heavy atom
        "atoms": [[to3d[f], drawn[f][0], drawn[f][1], round(pos.GetAtomPosition(f).x, 4), round(pos.GetAtomPosition(f).y, 4)]
                  for f in range(depicted.GetNumAtoms())],
        "bonds": [[to3d[b.GetBeginAtomIdx()], to3d[b.GetEndAtomIdx()]] for b in depicted.GetBonds()],
    }

    energies = []
    if mol.HasProp("conformer_energies"):
        try:
            energies = [float(e) for e in json.loads(mol.GetProp("conformer_energies"))]
        except ValueError:
            energies = []
    count = mol.GetNumConformers()
    if len(energies) != count:
        energies = []
    conformers = {
        "count": count,
        "forcefield": mol.GetProp("forcefield") if mol.HasProp("forcefield") else None,
        "energies": [round(e, 3) for e in energies],
        "delta": [round(e - energies[0], 3) for e in energies] if energies else [],
        "file": f"{name}.conformers.sdf" if count > 1 else f"{name}.sdf",
    }
    record = {
        "spec": "rdkit-molecule/1", "name": name,
        "smiles": props["smiles"], "inchi": inchi, "inchikey": inchikey, "formula": props["formula"],
        "sdf": f"{name}.sdf", "svg": f"{name}.svg",
        "properties": props,
        "rules": {
            "lipinski": {"pass": props["lipinski_violations"] <= 1, "violations": props["lipinski"]},
            "veber": {"pass": not props["veber_violations"], "violations": props["veber"]},
        },
        "flags": _flags(props, groups, alerts, centres, geometry),
        "stereocentres": [{"atom": i, "label": label, "geometry": geometry.get(i)} for i, label in centres],
        "groups": groups, "alerts": alerts,
        "atoms": atoms, "depiction": depiction, "conformers": conformers, "parent": relation,
        "updatedAt": _now(),
    }
    return record, svg


def write_outputs(mol: Chem.Mol, name: str, out: str | Path = "out/", *, parent=None) -> dict:
    """Everything the harness reads, for one molecule: `out/<name>.sdf` (the lowest conformer, the
    pane's artifact), `<name>.conformers.sdf` (all of them, when there are several), `<name>.svg` and
    `.png` (the 2D depiction), `<name>.molecule.json` (the pane's facts), `series.json` (the series),
    `properties.json` (the panel) and `report.json` (the verdict). Returns the report.

    `parent` is the molecule this one is an analogue of — a name already in the series, or a SMILES;
    left out, the most similar earlier molecule is taken (Tanimoto ≥ 0.35); `False` for none."""
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    mol.SetProp("_Name", name)
    progress(out, name, "describing")
    series = read_series(out)
    record, svg = describe(mol, name, parent=parent, out=out, series=series)
    props = record["properties"]
    conformers = mol.GetNumConformers()
    progress(out, name, "writing")
    _write(out / f"{name}.svg", svg)
    png = depict(mol, out / f"{name}.png")
    sdf = out / f"{name}.sdf"
    energies = record["conformers"]["energies"]
    if conformers > 1:  # the ensemble first, so the single-conformer SDF stays the newest structure file
        _write(out / f"{name}.conformers.sdf", _sdf_text(mol, name, range(conformers), energies))
    else:
        stale = out / f"{name}.conformers.sdf"
        if stale.exists():
            stale.unlink()
    if conformers:
        text = _sdf_text(mol, name, [0], energies)
        _write(sdf, text)
        record["sdfSha1"] = hashlib.sha1(text.encode()).hexdigest()  # how the pane knows the record is this SDF's
    _write(out / f"{name}.molecule.json", json.dumps(record, indent=1) + "\n")
    energy_block = {
        "forcefield": mol.GetProp("forcefield") if mol.HasProp("forcefield") else None,
        "before": round(mol.GetDoubleProp("energy_before"), 2) if mol.HasProp("energy_before") else None,
        "final": round(mol.GetDoubleProp("energy"), 2) if mol.HasProp("energy") else None,
    }
    relation = record["parent"]
    report = {
        "name": name,
        "smiles": props["smiles"],
        "formula": props["formula"],
        "inchikey": record["inchikey"],
        "atoms": mol.GetNumAtoms(),
        "conformers": conformers,
        "conformer_energies": energies,
        "energies": energy_block,
        "violations": props["lipinski"],
        "veber": props["veber"],
        "alerts": [f"{a['catalog']}: {a['name']}" for a in record["alerts"]],
        "unspecified_stereocenters": props["unspecified_stereocenters"],
        "parent": {k: relation[k] for k in ("name", "similarity", "change", "inferred")} if relation else None,
        "sdf": str(sdf) if conformers else None,
        "png": str(png),
        "properties": props,
        "updatedAt": _now(),
    }
    _write(out / "properties.json", json.dumps({"name": name, **props}, indent=2) + "\n")
    _write(out / "report.json", json.dumps(report, indent=2) + "\n")
    _update_series(out, series, record, conformers)
    progress(out, name, "done")
    change = f" · vs {relation['name']}: {relation['change']}, Tanimoto {relation['similarity']:.2f}" if relation else ""
    print(f"{sdf if conformers else png} · {props['formula']} · MW {props['mw']} · cLogP {props['logp']} · "
          f"{conformers} conformer{'s' if conformers != 1 else ''} · {props['lipinski_violations']} Lipinski violation(s){change}")
    return report


def _sdf_text(mol: Chem.Mol, name: str, conf_ids: Iterable[int], energies: list[float]) -> str:
    chunks = []
    field = mol.GetProp("forcefield") if mol.HasProp("forcefield") else None
    for cid in conf_ids:
        block = Chem.MolToMolBlock(mol, confId=cid).splitlines()
        block[0] = name
        text = "\n".join(block) + "\n"
        data = []
        if field:
            data.append(("forcefield", field))
        if energies and cid < len(energies):
            data.append(("energy", f"{energies[cid]:.4f}"))
            data.append(("delta_energy", f"{energies[cid] - energies[0]:.4f}"))
        data.append(("conformer", str(cid + 1)))
        if cid == 0 and mol.HasProp("energy_before"):
            data.append(("energy_before", f"{mol.GetDoubleProp('energy_before'):.4f}"))
        for key, value in data:
            text += f">  <{key}>\n{value}\n\n"
        chunks.append(text + "$$$$\n")
    return "".join(chunks)


def _update_series(out: Path, series: dict, record: dict, conformers: int) -> None:
    now = _now()
    props = record["properties"]
    relation = record["parent"]
    entry = {
        "name": record["name"], "smiles": record["smiles"], "formula": record["formula"], "inchikey": record["inchikey"],
        "sdf": record["sdf"], "svg": record["svg"], "json": f"{record['name']}.molecule.json", "conformers": conformers,
        "parent": relation["name"] if relation else None,
        "similarity": relation["similarity"] if relation else None,
        "change": relation["change"] if relation else None,
        "properties": {k: props[k] for k in ("mw", "logp", "tpsa", "hbd", "hba", "rotatable_bonds", "aromatic_rings", "qed",
                                              "fsp3", "formal_charge", "heavy_atoms", "lipinski_violations", "veber_violations")},
        "alerts": len(record["alerts"]),
        "createdAt": now, "updatedAt": now,
    }
    molecules = [m for m in series.get("molecules", []) if isinstance(m, dict)]
    for k, existing in enumerate(molecules):
        if existing.get("name") == entry["name"]:
            entry["createdAt"] = existing.get("createdAt") or now
            molecules[k] = entry
            break
    else:
        molecules.append(entry)
    _write(out / SERIES, json.dumps({"spec": "rdkit-series/1", "updatedAt": now, "molecules": molecules}, indent=1) + "\n")


def design(smiles: str, name: str, *, seed: int = 7, out: str | Path = "out/", conformers: int = 10, parent=None) -> dict:
    """SMILES in, everything out: parse, search `conformers` conformers (ETKDGv3 + MMFF94), describe,
    write. `parent` names the molecule this is an analogue of (inferred when left out). The one call a
    simple request needs."""
    progress(out, name, "embedding", f"{conformers} conformer{'s' if conformers != 1 else ''}")
    mol = mol_from_smiles(smiles, name)
    try:
        confs = embed_conformers(mol, n=conformers, seed=seed, on_stage=lambda stage, detail: progress(out, name, stage, detail))
        return write_outputs(confs, name, out=out, parent=parent)
    except Exception as error:
        progress(out, name, "failed", str(error).splitlines()[0][:160])
        raise


def similarity(a: "str | Chem.Mol", b: "str | Chem.Mol", radius: int = 2, bits: int = 2048) -> float:
    """Tanimoto over Morgan (ECFP4 at radius 2) fingerprints: 1.0 identical, > 0.7 close analogues,
    < 0.3 unrelated. Takes SMILES or molecules."""
    gen = rdFingerprintGenerator.GetMorganGenerator(radius=radius, fpSize=bits)
    return float(DataStructs.TanimotoSimilarity(gen.GetFingerprint(_as_mol(a)), gen.GetFingerprint(_as_mol(b))))


def substructure(mol: "str | Chem.Mol", smarts: str) -> tuple[tuple[int, ...], ...]:
    """Every match of a SMARTS pattern, as tuples of atom indices; empty when the scaffold is absent."""
    query = Chem.MolFromSmarts(smarts)
    if query is None:
        raise ValueError(f"not a valid SMARTS: {smarts!r}")
    return _as_mol(mol).GetSubstructMatches(query)


def read_smi(path: str | Path) -> list[Chem.Mol]:
    """A `.smi` list — one `SMILES name` per line, `#` comments ignored — as molecules."""
    mols: list[Chem.Mol] = []
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        mols.append(mol_from_smiles(parts[0], parts[1].strip() if len(parts) > 1 else None))
    return mols


def table(mols: Iterable[Chem.Mol]) -> "list[dict]":
    """One properties row per molecule, ready for `pandas.DataFrame(table(mols))`."""
    return [{"name": m.GetProp("_Name") if m.HasProp("_Name") else "", **properties(m)} for m in mols]


# ---- files the toolchain did not write: what the pane asks for ------------------------------------

def load_structure(path: "str | Path") -> Chem.Mol:
    """An SDF/MOL/PDB/MOL2 as one molecule with every conformer found for it: the records of the file
    that share its graph, or `<name>.conformers.sdf` beside it. MMFF single-point energies are filled
    in when the file carries none."""
    path = Path(path)
    suffix = path.suffix.lower()
    stem = path.name[: -len(".conformers.sdf")] if path.name.endswith(".conformers.sdf") else path.stem
    if suffix in (".sdf", ".mol", ".sd"):
        records = [m for m in Chem.SDMolSupplier(str(path), removeHs=False) if m is not None]
        ensemble = path.with_name(f"{stem}.conformers.sdf")
        if ensemble.exists() and ensemble != path:
            extra = [m for m in Chem.SDMolSupplier(str(ensemble), removeHs=False) if m is not None]
            if extra and records and extra[0].GetNumAtoms() == records[0].GetNumAtoms():
                records = extra
    elif suffix == ".pdb":
        pdb = Chem.MolFromPDBFile(str(path), removeHs=False)
        if pdb is not None:  # a PDB has connectivity but no bond orders; perceive them for a neutral molecule
            try:
                from rdkit.Chem import rdDetermineBonds
                perceived = Chem.Mol(pdb)
                rdDetermineBonds.DetermineBondOrders(perceived, charge=0)
                pdb = perceived
            except Exception:
                pass
        records = [pdb]
    elif suffix == ".mol2":
        records = [Chem.MolFromMol2File(str(path), removeHs=False)]
    else:
        raise ValueError(f"cannot read {path.suffix} files")
    records = [m for m in records if m is not None]
    if not records:
        raise ValueError(f"{path.name}: no molecule RDKit could sanitize")
    base = Chem.Mol(records[0])
    elements = [a.GetAtomicNum() for a in base.GetAtoms()]
    energies: list[float] = []
    for extra in records[1:]:
        if [a.GetAtomicNum() for a in extra.GetAtoms()] == elements and extra.GetNumConformers():
            base.AddConformer(Chem.Conformer(extra.GetConformer()), assignId=True)
    for k, record in enumerate(records[: base.GetNumConformers()]):
        if record.HasProp("energy"):
            try:
                energies.append(float(record.GetProp("energy")))
            except ValueError:
                pass
    if len(energies) != base.GetNumConformers() and base.GetNumConformers() and base.GetConformer().Is3D():
        try:
            field, _ = _forcefield(base)
            energies = [float(_forcefield(base, c.GetId())[1].CalcEnergy()) for c in base.GetConformers()]
            base.SetProp("forcefield", field)
        except Exception:
            energies = []
    if records[0].HasProp("forcefield"):
        base.SetProp("forcefield", records[0].GetProp("forcefield"))
    if energies and len(energies) == base.GetNumConformers():
        base.SetProp("conformer_energies", json.dumps(energies))
    base.SetProp("_Name", stem)
    return base


def describe_file(path: "str | Path") -> dict:
    """`describe` for a file on disk, with the series of its folder for the parent. The record carries
    its SVG inline (`svgText`), since nothing is written."""
    path = Path(path).resolve()
    mol = load_structure(path)
    name = mol.GetProp("_Name")
    series = read_series(path.parent)
    if not any(m.get("name") == name for m in series.get("molecules", [])):
        series = {**series, "molecules": [*series.get("molecules", []), {"name": name}]}
    record, svg = describe(mol, name, out=path.parent, series=series)
    record["svgText"] = svg
    record["computedBy"] = "viewer"
    return record


def _serve() -> int:
    """One JSON request per line on stdin (`{"id", "op": "describe", "path"}`), one answer per line."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        reply = {"id": request.get("id")}
        try:
            if request.get("op") == "describe":
                reply.update(ok=True, result=describe_file(request["path"]))
            elif request.get("op") == "ping":
                reply.update(ok=True, result="pong")
            else:
                reply.update(ok=False, error=f"unknown op {request.get('op')!r}")
        except Exception as error:  # the pane shows the message; the worker keeps serving
            reply.update(ok=False, error=f"{type(error).__name__}: {error}"[:400])
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()
    return 0


def main(argv: list[str]) -> int:
    import argparse
    parser = argparse.ArgumentParser(prog="harness_rdkit")
    sub = parser.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("design", help="SMILES → out/<name>.sdf and everything the pane reads")
    d.add_argument("smiles")
    d.add_argument("name")
    d.add_argument("--parent", default=None)
    d.add_argument("--conformers", type=int, default=10)
    d.add_argument("--seed", type=int, default=7)
    d.add_argument("--out", default="out/")
    s = sub.add_parser("describe", help="print the molecule.json record of a structure file")
    s.add_argument("path")
    sub.add_parser("serve", help="describe requests over stdin, for the pane")
    args = parser.parse_args(argv)
    if args.cmd == "design":
        design(args.smiles, args.name, seed=args.seed, out=args.out, conformers=args.conformers,
               parent=(False if args.parent == "none" else args.parent))
        return 0
    if args.cmd == "describe":
        print(json.dumps(describe_file(args.path), indent=1))
        return 0
    return _serve()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
