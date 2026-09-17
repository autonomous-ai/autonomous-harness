"""The starter: ibuprofen from its SMILES, embedded in 3D, minimised, and written out — the SDF the
pane rotates, the 2D depiction in its corner, the properties in its panel, the report the verdict
reads. Replace it: another molecule, an analogue of this one, a whole series under molecules/."""
from harness_rdkit import design, similarity

report = design("CC(C)Cc1ccc(cc1)C(C)C(=O)O", "ibuprofen")

# Every molecule is one call away from the next: an analogue, and how close it stayed.
print(f"vs naproxen: {similarity(report['smiles'], 'COc1ccc2cc(ccc2c1)C(C)C(=O)O'):.2f} Tanimoto")
