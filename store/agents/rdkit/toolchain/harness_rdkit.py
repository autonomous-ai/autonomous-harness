"""The few lines every molecule here needs: build it from SMILES, embed a 3D conformer, and write the
files the pane and the verdict read — an SDF with coordinates, a 2D depiction, the properties, a report.

    from harness_rdkit import design
    design("CC(C)Cc1ccc(cc1)C(C)C(=O)O", "ibuprofen")   # out/ibuprofen.sdf + .png + properties.json + report.json

or the three steps by hand, when a molecule needs work in between:

    from harness_rdkit import mol_from_smiles, embed_3d, write_outputs
    mol = mol_from_smiles("CN1C=NC2=C1C(=O)N(C)C(=O)N2C", "caffeine")
    write_outputs(embed_3d(mol, seed=7), "caffeine")
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Iterable

from rdkit import Chem, DataStructs, RDLogger
from rdkit.Chem import AllChem, Crippen, Descriptors, Draw, Lipinski, QED, rdDepictor
from rdkit.Chem import rdDistGeom, rdFingerprintGenerator, rdMolDescriptors
from rdkit.Chem.Draw import rdMolDraw2D

RDLogger.DisableLog("rdApp.info")  # the parser's chatter is not the agent's business

# Lipinski's rule of five: the four tests, and the threshold each one fails at.
RULE_OF_FIVE = (("mw", 500.0), ("logp", 5.0), ("hbd", 5.0), ("hba", 10.0))


def _as_mol(value: "str | Chem.Mol") -> Chem.Mol:
    return mol_from_smiles(value) if isinstance(value, str) else value


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
    return molh


def _minimise(mol: Chem.Mol, max_iters: int) -> tuple[str, float, float]:
    if AllChem.MMFFHasAllMoleculeParams(mol):
        field, ff = "MMFF94", AllChem.MMFFGetMoleculeForceField(mol, AllChem.MMFFGetMoleculeProperties(mol))
    else:
        field, ff = "UFF", AllChem.UFFGetMoleculeForceField(mol)
    before = float(ff.CalcEnergy())
    ff.Minimize(maxIts=max_iters)
    return field, before, float(ff.CalcEnergy())


def properties(mol: Chem.Mol) -> dict:
    """The numbers a medicinal chemist asks for first, on the molecule without its hydrogens."""
    flat = Chem.RemoveHs(mol)
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
    }
    violations = [f"{key} {values[key]} > {limit:g}" for key, limit in RULE_OF_FIVE if values[key] > limit]
    return {**values, "lipinski_violations": len(violations), "lipinski": violations}


def depict(mol: Chem.Mol, path: str | Path, size: tuple[int, int] = (600, 400)) -> Path:
    """The flat picture the pane shows in its corner: 2D coordinates, stereo annotated, 600×400 PNG."""
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


def write_outputs(mol: Chem.Mol, name: str, out: str | Path = "out/") -> dict:
    """Everything the harness reads, for one molecule: `out/<name>.sdf` (the 3D conformer, the pane's
    artifact), `out/<name>.png` (the 2D depiction), `out/properties.json` (the panel) and
    `out/report.json` (the verdict). Returns the report."""
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    mol.SetProp("_Name", name)
    sdf = out / f"{name}.sdf"
    conformers = mol.GetNumConformers()
    if conformers:
        with Chem.SDWriter(str(sdf)) as writer:
            writer.write(mol)
    png = depict(mol, out / f"{name}.png")
    props = properties(mol)
    energies = {
        "forcefield": mol.GetProp("forcefield") if mol.HasProp("forcefield") else None,
        "before": round(mol.GetDoubleProp("energy_before"), 2) if mol.HasProp("energy_before") else None,
        "final": round(mol.GetDoubleProp("energy"), 2) if mol.HasProp("energy") else None,
    }
    report = {
        "name": name,
        "smiles": props["smiles"],
        "formula": props["formula"],
        "atoms": mol.GetNumAtoms(),
        "conformers": conformers,
        "energies": energies,
        "violations": props["lipinski"],
        "sdf": str(sdf) if conformers else None,
        "png": str(png),
        "properties": props,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (out / "properties.json").write_text(json.dumps({"name": name, **props}, indent=2) + "\n")
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"{sdf if conformers else png} · {props['formula']} · MW {props['mw']} · cLogP {props['logp']} · "
          f"{props['lipinski_violations']} Lipinski violation(s)")
    return report


def design(smiles: str, name: str, *, seed: int = 7, out: str | Path = "out/") -> dict:
    """SMILES in, everything out: parse, embed, minimise, write. The one call a simple request needs."""
    return write_outputs(embed_3d(mol_from_smiles(smiles, name), seed=seed), name, out=out)


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
