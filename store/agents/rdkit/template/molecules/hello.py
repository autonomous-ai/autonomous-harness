"""The starter: ibuprofen from its SMILES, its conformers searched and minimised, and written out — the
SDFs the pane turns and plays, the 2D depiction linked to them, the charges, groups and properties it
shows, the series it starts, the report the verdict reads. Replace it: another molecule, an analogue of
this one (`design(smiles, name, parent="ibuprofen")`), a whole series under molecules/."""
from harness_rdkit import design, similarity

report = design("CC(C)Cc1ccc(cc1)C(C)C(=O)O", "ibuprofen")

# Every molecule is one call away from the next: an analogue, and how close it stayed.
print(f"vs naproxen: {similarity(report['smiles'], 'COc1ccc2cc(ccc2c1)C(C)C(=O)O'):.2f} Tanimoto")
