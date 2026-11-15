# design-system/ (makeover exploration, node makeover-design)
- `AUDIT.md`, `REFERENCES.md`, `DIRECTIONS.md`, `COMPONENTS.md`, `APPLY_PLAN.md`, `RECOMMENDATION.md`
- `tokens.A.css`, `tokens.B.css`: drop-in for `src/snapshot/tokens.css` (B is applied; the two files must stay identical); `contrast.py` checks them.
- `proto/`: static prototypes. Regenerate with `python3 proto/gen.py`. View: `python3 -m http.server 6797` in this folder, open `/proto/A-runs.html?theme=light`.
- `shots/`: prototype shots `<A|B>-<runs|chats|profiles>-<1280|375>-<dark|light>.png`; `shots/audit/`: current UI.
- `research/`: uux search output, contrast tables, reference READMEs and images.
- `fonts/`: Plex (copied) and Geist (OFL) woff2 used by the prototypes.
