---
name: rdkit
description: Build molecules with RDKit — from SMILES or a scaffold, analogues and series (each with its parent), properties (MW, cLogP, TPSA, Lipinski, Veber, QED, alerts), similarity and substructure search, conformer ensembles written as SDF for the pane. Use for any request that ends in a molecule, a property or a chemical series.
---

# rdkit

RDKit is the cheminformatics toolkit: a molecule is a graph (`Chem.Mol`), written as SMILES, queried
with SMARTS, given coordinates by distance geometry. Tools: `$RDKIT_PYTHON` (the pinned venv, with
numpy and pandas), `harness_rdkit` on `PYTHONPATH` (build, embed, write, compare),
`$RDKIT_TOOLCHAIN/verdict.py` (the pane header). Never install another RDKit.

## Build, write, verdict

```bash
"$RDKIT_PYTHON" molecules/hello.py                        # runs the script → out/<name>.sdf and the rest
"$RDKIT_PYTHON" "$RDKIT_TOOLCHAIN/verdict.py"             # judges the newest molecule → pane header
"$RDKIT_PYTHON" "$RDKIT_TOOLCHAIN/harness_rdkit.py" design "CCO" ethanol   # the same, without a script
```

```python
from harness_rdkit import design, mol_from_smiles, embed_conformers, embed_3d, write_outputs, properties, similarity, substructure

design("CC(C)Cc1ccc(cc1)C(C)C(=O)O", "ibuprofen")         # parse → 10 conformers → minimise → describe → write
design("CC(C)(O)Cc1ccc(C(C)C(=O)O)cc1", "ibuprofen_oh", parent="ibuprofen")   # an analogue: name its parent

mol = mol_from_smiles("CN1C=NC2=C1C(=O)N(C)C(=O)N2C", "caffeine")   # the steps, when work happens between
confs = embed_conformers(mol, n=10, seed=7)               # ETKDGv3 + MMFF94, deduplicated, lowest first, aligned
write_outputs(confs, "caffeine", parent=False)            # False: not an analogue of anything here
```

What `design`/`write_outputs` write to `out/`, and what each is for:

| file | what it is | who reads it |
|---|---|---|
| `<name>.sdf` | the lowest-energy conformer | the pane (the artifact), the verdict, PyMOL/ChimeraX |
| `<name>.conformers.sdf` | every kept conformer, lowest first, with `energy`/`delta_energy` | the pane's conformer player |
| `<name>.svg`, `<name>.png` | the 2D depiction (the SVG drawn on the parent's core) | the pane, reports |
| `<name>.molecule.json` | identifiers, properties, Lipinski/Veber, plain-language flags, per-atom Gasteiger charge, Crippen logP and hybridisation, functional groups, PAINS/Brenk alerts, conformer energies, the parent and the atoms that changed | the pane |
| `series.json` | every molecule designed here, in order, with its parent and key properties | the pane's series strip and table |
| `properties.json`, `report.json` | the newest molecule's properties; the verdict's input | the verdict |

The pane shows the molecule while it is being made (`out/.progress.json`: embedding, minimising,
describing); never write these files by hand. `properties(mol)` returns the properties without
writing; `depict(mol, path)` the PNG alone; `describe(mol, name)` the record and SVG without writing.
`read_smi("molecules/series.smi")` reads a `SMILES name` list, `table(mols)` turns molecules into rows
for `pandas.DataFrame`.

**Parents.** An analogue is compared with its parent: the maximum common substructure, the atoms that
changed (`+O`, `−C +O`), the property deltas, a 2D depiction drawn on the parent's core and a 3D pose
superposed on it. Pass `parent="<name already designed>"` (or a SMILES) whenever you make an analogue;
left out, the parent is inferred as the earlier molecule this one is the smallest edit of, and
`parent=False` says there is none. Design the lead first, then its analogues, so the series reads in
order.

## SMILES, the parts that matter

- Atoms are bare symbols; lowercase is aromatic (`c1ccccc1` benzene). Bonds: `-` single (implicit),
  `=` double, `#` triple, `/` `\` around a double bond for E/Z.
- Branches in parentheses: `CC(C)C` isobutane. Rings close on matching digits: `C1CCCCC1` cyclohexane,
  `c1ccc2ccccc2c1` naphthalene. Reuse a digit once it is closed.
- Brackets for anything not a default: charge `[NH4+]`, `[O-]`; isotope `[13C]`; explicit H `[nH]` —
  pyrrole is `c1cc[nH]c1`, and forgetting the `H` is the commonest SMILES error there is.
- Stereo: `[C@H]` / `[C@@H]` at a centre, `F/C=C/F` trans. Write it when it matters; RDKit will not
  guess, and an unspecified centre silently becomes a racemate.
- Dot separates components: a salt is `CC(=O)[O-].[Na+]`, and most calculations want the parent only.

Useful anchors: water `O`, ethanol `CCO`, benzene `c1ccccc1`, phenol `Oc1ccccc1`, aspirin
`CC(=O)Oc1ccccc1C(=O)O`, paracetamol `CC(=O)Nc1ccc(O)cc1`, caffeine `CN1C=NC2=C1C(=O)N(C)C(=O)N2C`,
ibuprofen `CC(C)Cc1ccc(cc1)C(C)C(=O)O`, naproxen `COc1ccc2cc(ccc2c1)C(C)C(=O)O`, glucose
`OC[C@H]1OC(O)[C@H](O)[C@@H](O)[C@@H]1O`, penicillin G core `CC1(C)S[C@@H]2[C@H](NC(=O)Cc3ccccc3)C(=O)N2[C@H]1C(=O)O`.

## SMARTS, for finding things

SMARTS is SMILES plus queries: `[#6]` any carbon, `[C,N]` either, `[!c]` not aromatic carbon, `[R2]`
in two rings, `[X3]` three connections, `[OX2H]` a hydroxyl oxygen, `*` anything, `~` any bond.

```python
substructure(mol, "[OX2H]")                  # hydroxyls → ((3,), (7,))
substructure(mol, "c1ccccc1")                # benzene rings
substructure(mol, "[CX3](=O)[OX2H1]")        # carboxylic acid
```

Groups worth keeping: carboxylic acid `[CX3](=O)[OX2H1]`, amide `[NX3][CX3](=[OX1])`, primary amine
`[NX3;H2;!$(NC=O)]`, sulfonamide `[SX4](=[OX1])(=[OX1])([NX3])`, nitro `[N+](=O)[O-]`, halogen `[F,Cl,Br,I]`.

## Common tasks

**Modify a scaffold** — edit the SMILES where the substituent goes, or replace a group in place:

```python
from rdkit import Chem
core = Chem.MolFromSmiles("CC(=O)Oc1ccccc1C(=O)O")
out  = Chem.ReplaceSubstructs(core, Chem.MolFromSmarts("[CX3](=O)[OX2H1]"),
                              Chem.MolFromSmiles("C(=O)NC"), replaceAll=True)[0]
Chem.SanitizeMol(out); print(Chem.MolToSmiles(out))
```

**Enumerate analogues** — one substituent list, one loop, a table, and the ones worth looking at written
out, each with its parent:

```python
import pandas as pd
from rdkit import Chem
from harness_rdkit import mol_from_smiles, properties, design
subs = {"H": "", "F": "F", "Cl": "Cl", "OMe": "OC", "CF3": "C(F)(F)F"}
mols = [mol_from_smiles(f"CC(C)Cc1ccc(C(C)C(=O)O)c({r})c1" if r else "CC(C)Cc1ccc(cc1)C(C)C(=O)O", name)
        for name, r in subs.items()]
print(pd.DataFrame([{"R": m.GetProp("_Name"), **properties(m)} for m in mols])[["R", "mw", "logp", "tpsa", "qed"]])
design("CC(C)Cc1ccc(cc1)C(C)C(=O)O", "ibuprofen")         # the lead first
design(Chem.MolToSmiles(mols[-1]), "analogue_cf3", parent="ibuprofen")   # then the analogue, into the series
```

**Similarity search across a list** — Morgan (ECFP4) Tanimoto; > 0.7 is a close analogue, < 0.3 unrelated:

```python
from harness_rdkit import read_smi, similarity
query = "CC(=O)Oc1ccccc1C(=O)O"
hits = sorted(((similarity(query, m), m.GetProp("_Name")) for m in read_smi("molecules/library.smi")), reverse=True)
for score, name in hits[:10]: print(f"{score:.2f}  {name}")
```

**3D and conformers** — `design` already runs a small conformer search (`conformers=10`): ETKDGv3
embeddings, MMFF94 minimisation, duplicates dropped, the lowest within 10 kcal/mol kept, aligned, and
written as the ensemble the pane plays. Raise it for a flexible molecule (`conformers=30`), lower it to
`1` for a single seed-7 pose. `embed_conformers(mol, n, seed)` is the same search by hand; an
unspecified stereocentre is pinned to one configuration across the ensemble and still reported as
unspecified. Energies are vacuum force-field numbers — a guide to shape, not to populations.

**Save for other tools**: `write_outputs` writes the SDFs. `Chem.MolToPDBFile(mol, "out/x.pdb")`,
`Chem.MolToXYZFile(mol, "out/x.xyz")`, `Chem.MolToSmiles(mol)` for the canonical string.

## Pitfalls

- **Sanitization is not optional.** `Chem.MolFromSmiles` returns `None` for anything that will not
  sanitize — a five-valent carbon, an unclosed ring, `c1ccccc1` written with the wrong aromaticity.
  A `None` is a typo in the SMILES; fix the string, never `sanitize=False` your way past it.
- **Hydrogens.** Properties are computed on the graph without them; 3D needs them. `embed_3d` adds
  them and gives you a new molecule — the original stays flat, which is what the depiction wants.
- **Stereo.** An unspecified centre embeds as one arbitrary enantiomer and the SDF will look decided.
  Write the stereo into the SMILES, or say in your answer that the centre is unspecified.
- **Protonation.** SMILES are written neutral by convention; a carboxylic acid is `C(=O)O` even though
  it is an anion at pH 7.4. cLogP and TPSA assume the neutral form — say so rather than "correcting" it.
- **Salts and mixtures.** Strip them before computing: `Chem.MolStandardize.rdMolStandardize.LargestFragmentChooser()`.
- **Macrocycles and cages** sometimes fail to embed; `embed_3d` retries with random coordinates, and
  after that it is a different seed or `useMacrocycleTorsions`.
- **cLogP is Crippen's estimate**, QED a 2012 desirability score, Lipinski a rule of thumb for oral
  absorption. They are guides, not measurements, and nothing here predicts activity, binding or safety.

## Rules

- `molecules/` holds scripts and `.smi` lists, `out/` holds everything produced. One `design` call per
  molecule, `name` matching the file you want in the pane.
- Run the verdict after every script: `"$RDKIT_PYTHON" "$RDKIT_TOOLCHAIN/verdict.py"`. It is ready when
  a script exists, the newest `out/*.sdf` parses with a real 3D conformer, and no error is open;
  Lipinski and Veber violations, PAINS/Brenk alerts and a strained energy are warnings, an unspecified
  stereocentre a note — none of them failures.
- The pane opens the newest molecule and follows each new one: 3D (wire, stick, ball-and-stick,
  spacefill; hydrogens; colour by element, Gasteiger charge, Crippen lipophilicity or change from the
  parent; VDW/SAS/SES surfaces coloured by electrostatic or lipophilicity potential; hover for an atom's
  charge and hybridisation; click to measure distances, angles and dihedrals), the 2D depiction linked
  atom-for-atom with its functional groups, the properties with Lipinski/Veber badges and plain-language
  flags, the conformer player, the parent overlay, and the series as a strip and a comparison table.
  Writing the files through `design`/`write_outputs` is how you put something in it; point the user at
  what to look at ("colour by change", "the conformer tab") rather than describing the picture.
