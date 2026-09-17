---
name: rdkit
description: Build molecules with RDKit — from SMILES or a scaffold, analogues and series, properties (MW, cLogP, TPSA, Lipinski, QED), similarity and substructure search, 3D conformers written as SDF for the pane. Use for any request that ends in a molecule, a property or a chemical series.
---

# rdkit

RDKit is the cheminformatics toolkit: a molecule is a graph (`Chem.Mol`), written as SMILES, queried
with SMARTS, given coordinates by distance geometry. Tools: `$RDKIT_PYTHON` (the pinned venv, with
numpy and pandas), `harness_rdkit` on `PYTHONPATH` (build, embed, write, compare),
`$RDKIT_TOOLCHAIN/verdict.py` (the pane header). Never install another RDKit.

## Build, write, verdict

```bash
"$RDKIT_PYTHON" molecules/hello.py                        # runs the script → out/<name>.sdf + .png + JSON
"$RDKIT_PYTHON" "$RDKIT_TOOLCHAIN/verdict.py"             # judges the newest conformer → pane header
```

```python
from harness_rdkit import design, mol_from_smiles, embed_3d, write_outputs, properties, similarity, substructure

design("CC(C)Cc1ccc(cc1)C(C)C(=O)O", "ibuprofen")         # parse → 3D → minimise → write. One call.

mol = mol_from_smiles("CN1C=NC2=C1C(=O)N(C)C(=O)N2C", "caffeine")   # the steps, when work happens between
conf = embed_3d(mol, seed=7)                              # ETKDGv3 + MMFF94; a NEW mol, with hydrogens
write_outputs(conf, "caffeine")                           # out/caffeine.sdf, .png, properties.json, report.json
```

`write_outputs` is what the pane and the verdict read: the SDF is the artifact the pane rotates,
`properties.json` fills its panel, `report.json` is the verdict's input. `properties(mol)` returns the
same dict without writing; `depict(mol, path)` the PNG alone. `read_smi("molecules/series.smi")` reads
a `SMILES name` list, `table(mols)` turns molecules into rows for `pandas.DataFrame`.

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

**Enumerate analogues** — one substituent list, one loop, a table, and the best one written out:

```python
import pandas as pd
from harness_rdkit import mol_from_smiles, properties, design
subs = {"H": "", "F": "F", "Cl": "Cl", "OMe": "OC", "CF3": "C(F)(F)F"}
mols = [mol_from_smiles(f"CC(C)Cc1ccc({r}cc1)C(C)C(=O)O" if r else "CC(C)Cc1ccc(cc1)C(C)C(=O)O", name)
        for name, r in subs.items()]
print(pd.DataFrame([{"R": m.GetProp("_Name"), **properties(m)} for m in mols])[["R", "mw", "logp", "tpsa", "qed"]])
design(Chem.MolToSmiles(mols[-1]), "analogue-cf3")        # the one worth looking at, into the pane
```

**Similarity search across a list** — Morgan (ECFP4) Tanimoto; > 0.7 is a close analogue, < 0.3 unrelated:

```python
from harness_rdkit import read_smi, similarity
query = "CC(=O)Oc1ccccc1C(=O)O"
hits = sorted(((similarity(query, m), m.GetProp("_Name")) for m in read_smi("molecules/library.smi")), reverse=True)
for score, name in hits[:10]: print(f"{score:.2f}  {name}")
```

**3D and conformers** — `embed_3d(mol, seed=7)` is one minimised conformer at a fixed seed (same input,
same coordinates). For a conformer search, embed many and keep the lowest:

```python
from rdkit.Chem import AllChem, rdDistGeom
from rdkit import Chem
molh = Chem.AddHs(mol_from_smiles(smiles, "flexible"))
p = rdDistGeom.ETKDGv3(); p.randomSeed = 7; p.pruneRmsThresh = 0.5
rdDistGeom.EmbedMultipleConfs(molh, numConfs=50, params=p)
best = min(AllChem.MMFFOptimizeMoleculeConfs(molh, maxIters=1000), key=lambda r: r[1])
```

**Save for other tools**: `write_outputs` writes the SDF. `Chem.MolToPDBFile(mol, "out/x.pdb")`,
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
  Lipinski violations and a strained force-field energy are warnings, not failures.
- The pane shows the newest SDF: stick-and-ball in Jmol colours, Spin and Surface toggles, the
  properties panel, the 2D PNG in the corner. Writing the file is how you put something in it.
