"""Independent reimport checks on live-test deliverables, not worker reports.

Run with an already-installed Solid/Workshop Python. No model calls or installs.
The optional mesh exports are derived from the verified STEP for a review image.
"""
import argparse
import json
import math
from pathlib import Path

from build123d import GeomType, Pos, export_stl, import_step
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps

parser = argparse.ArgumentParser()
parser.add_argument("token", type=Path)
parser.add_argument("assembly", type=Path)
parser.add_argument("--meshes", type=Path)
args = parser.parse_args()


def boolean_volume(operation, left, right):
    result = operation(left.wrapped, right.wrapped)
    result.Build()
    assert result.IsDone(), "CAD-kernel Boolean operation did not finish"
    properties = GProp_GProps()
    BRepGProp.VolumeProperties_s(result.Shape(), properties)
    return abs(properties.Mass())


token = import_step(args.token)
assembly = import_step(args.assembly)
solids = sorted(assembly.solids(), key=lambda solid: solid.bounding_box().size.X)
assert len(solids) == 2, "Assembly must contain exactly two independent solids"
placed_token, holder = solids
holder_radii = sorted({
    round(BRepAdaptor_Surface(face.wrapped).Cylinder().Radius(), 8)
    for face in holder.faces() if face.geom_type == GeomType.CYLINDER
})
token_size = list(token.bounding_box().size)
radial_clearance = min(holder_radii) - token_size[0] / 2
overlap = boolean_volume(BRepAlgoAPI_Common, placed_token, holder)
unplaced = Pos(0, 0, -2) * placed_token
identity_removed = boolean_volume(BRepAlgoAPI_Cut, token, unplaced)
identity_added = boolean_volume(BRepAlgoAPI_Cut, unplaced, token)
checks = {
    "one_upstream_solid": len(token.solids()) == 1,
    "two_assembly_solids": len(solids) == 2,
    "valid_upstream_brep": BRepCheck_Analyzer(token.wrapped, True).IsValid(),
    "valid_assembly_brep": BRepCheck_Analyzer(assembly.wrapped, True).IsValid(),
    "positive_volumes": all(solid.volume > 0 for solid in solids),
    "token_24_by_24_by_5_mm": all(abs(a - b) < 1e-6 for a, b in zip(token_size, [24, 24, 5])),
    "token_volume_700_pi_mm3": abs(token.volume - 700 * math.pi) < 1e-6,
    "holder_32_by_32_by_7_mm": all(abs(a - b) < 1e-6 for a, b in zip(holder.bounding_box().size, [32, 32, 7])),
    "holder_cylinder_radii": holder_radii == [12.3, 16.0],
    "radial_clearance_0_3_mm": abs(radial_clearance - 0.3) < 1e-6,
    "no_geometric_intersection": overlap < 1e-7,
    "upstream_token_geometry_preserved": identity_added < 1e-7 and identity_removed < 1e-7,
}
assert all(checks.values()), json.dumps(checks)
if args.meshes:
    args.meshes.mkdir(parents=True, exist_ok=True)
    for name, solid in [("holder.stl", holder), ("token.stl", placed_token)]:
        assert export_stl(solid, args.meshes / name, tolerance=0.01, angular_tolerance=0.05)
print(json.dumps({
    "method": "Independent STEP reimport; no worker Python executed",
    "units": "mm", "checks": checks, "all_checks_passed": all(checks.values()),
    "token_volume_mm3": token.volume, "holder_volume_mm3": holder.volume,
    "radial_clearance_mm": radial_clearance, "intersection_volume_mm3": overlap,
    "identity_removed_volume_mm3": identity_removed, "identity_added_volume_mm3": identity_added,
    "limitations": ["Numerical geometry only; no physical printing, insertion, or manufacturing tolerance verification"],
}, indent=2))
