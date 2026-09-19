# CPU experiment and optional Apple Silicon MLX

`train` executes the editable workspace `train.py`, then independently loads `model.npz` with pickle disabled and evaluates `holdout.txt`. The model, text and training-source hashes are recorded. Runs are compared only when train/holdout hashes agree. `mlx` runs a prepared workspace `mlx/train.py` with its own `.venv`; use the pinned upstream README for environment/data preparation.

## Verification scope

The Intel Mac acceptance path is the NumPy character model. Native MLX requires Apple Silicon and is separately identified. A best observed score is not a statistical-significance claim.

The browser acceptance suite lives in `store/viewers/studio-viewer/test/studios.e2e.mjs`.
`TESTING.md` beside that viewer records commands, outcomes, screenshots and coverage.
Upstream source revisions are in `upstream.lock.json`; install-time Python dependencies are
hash-locked in `requirements.lock`. No user application configuration is written by setup.
