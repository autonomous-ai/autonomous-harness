#!/usr/bin/env python
"""Judge the workspace's newest molecule and write .harness/verdict.json (spec 1).

    "$RDKIT_PYTHON" "$RDKIT_TOOLCHAIN/verdict.py"

Phases: Design (a script under molecules/ and an out/report.json), Embed (the newest out/*.sdf parses
and carries a conformer), Review (Lipinski and the force-field energy — warnings, never a gate).
Ready = designed, embedded and reviewed. The artifact is the newest SDF, which is what the pane shows.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

WS = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()

# A minimised small molecule sits well under this per-atom; above it the geometry is strained.
ENERGY_PER_ATOM_WARN = 10.0


def judge(has_design: bool, report: dict | None, sdf: dict | None) -> dict:
    """The whole verdict as a pure function of three facts, so it can be tested without RDKit.

    `sdf` is `{"path": str, "conformers": int, "atoms": int, "error": str | None}` for the newest SDF,
    or None when there is none yet."""
    findings: list[dict] = []
    designed = has_design and report is not None
    embedded = False
    if sdf is not None:
        if sdf.get("error"):
            findings.append({"severity": "error", "kind": "embed", "message": f"{sdf['path']} does not parse: {sdf['error']}",
                             "ref": sdf["path"]})
        elif not sdf.get("conformers"):
            findings.append({"severity": "error", "kind": "embed", "message": f"{sdf['path']} has no conformer — embed_3d before write_outputs",
                             "ref": sdf["path"]})
        else:
            embedded = True
    props = (report or {}).get("properties") or {}
    for violation in (report or {}).get("violations") or []:
        findings.append({"severity": "warning", "kind": "lipinski", "message": f"Lipinski: {violation}",
                         "ref": (report or {}).get("name")})
    energies = (report or {}).get("energies") or {}
    final, atoms = energies.get("final"), (report or {}).get("atoms") or 0
    if embedded and final is None:
        findings.append({"severity": "info", "kind": "energy", "message": "no force-field energy in the report — the conformer was not minimised"})
    elif final is not None and atoms and final / atoms > ENERGY_PER_ATOM_WARN:
        findings.append({"severity": "warning", "kind": "energy",
                         "message": f"{energies.get('forcefield', 'force field')} energy {final:g} kcal/mol over {atoms} atoms is strained — try another seed or more minimisation steps"})
    reviewed = embedded and not any(f["severity"] == "error" for f in findings)
    phases = [
        {"id": "design", "name": "Design", "state": "done" if designed else "active"},
        {"id": "embed", "name": "Embed", "state": ("done" if embedded else ("failed" if sdf else "active")) if designed else "pending"},
        {"id": "review", "name": "Review", "state": ("done" if reviewed else "active") if embedded else "pending"},
    ]
    if report:
        bits = [report.get("name") or "molecule", report.get("formula") or "?"]
        if props.get("mw") is not None:
            bits.append(f"MW {props['mw']}")
        if props.get("logp") is not None:
            bits.append(f"cLogP {props['logp']}")
        conformers = (sdf or {}).get("conformers") or 0
        bits.append(f"{conformers} conformer" + ("" if conformers == 1 else "s"))
        if final is not None:
            bits.append(f"{energies.get('forcefield', 'FF')} {final:g} kcal/mol")
        warnings = sum(1 for f in findings if f["severity"] == "warning")
        if warnings:
            bits.append(f"{warnings} warning" + ("" if warnings == 1 else "s"))
    else:
        bits = ["no molecule yet" if has_design else "no design yet"]
    return {"spec": 1, "ready": bool(reviewed), "summary": " · ".join(bits)[:200], "findings": findings,
            "artifact": (sdf or {}).get("path") if embedded else None,
            "phases": phases, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def newest_sdf(ws: Path) -> Path | None:
    files = sorted((p for p in ws.glob("out/**/*.sdf") if p.is_file()), key=lambda p: p.stat().st_mtime)
    return files[-1] if files else None


def inspect(path: Path) -> dict:
    """What the judge needs to know about an SDF. RDKit reads it; without RDKit the file is only counted."""
    info = {"path": str(path.relative_to(WS)), "conformers": 0, "atoms": 0, "error": None}
    try:
        from rdkit import Chem, RDLogger
        RDLogger.DisableLog("rdApp.*")
        mols = [m for m in Chem.SDMolSupplier(str(path), removeHs=False) if m is not None]
        if not mols:
            info["error"] = "no molecule RDKit could sanitize"
            return info
        info["atoms"] = sum(m.GetNumAtoms() for m in mols)
        info["conformers"] = sum(1 for m in mols if m.GetNumConformers() and m.GetConformer().Is3D())
        if not info["conformers"]:
            info["error"] = None  # judged as "no conformer", which says more than a parse error
    except ImportError:
        info["conformers"] = 1 if path.stat().st_size > 100 else 0
    except Exception as error:  # a truncated or half-written file
        info["error"] = str(error).splitlines()[0][:160]
    return info


def main(argv: list[str]) -> int:
    molecules = WS / "molecules"
    has_design = any(molecules.glob("*.py")) or any(molecules.glob("*.smi"))
    report = None
    report_path = WS / "out" / "report.json"
    if report_path.exists():
        try:
            report = json.loads(report_path.read_text())
        except ValueError:
            report = None
    path = Path(argv[1]).resolve() if len(argv) > 1 else newest_sdf(WS)
    verdict = judge(has_design, report, inspect(path) if path and path.exists() else None)
    (WS / ".harness").mkdir(exist_ok=True)
    (WS / ".harness" / "verdict.json").write_text(json.dumps(verdict, indent=2) + "\n")
    print(f"{'ready' if verdict['ready'] else 'not ready'} · {verdict['summary']}")
    for finding in verdict["findings"]:
        print(f"  {finding['severity']:<7} {finding['message']}")
    return 0 if verdict["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
