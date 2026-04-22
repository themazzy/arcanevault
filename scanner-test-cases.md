# Scanner Manual Test Cases

Use this checklist when validating Scanner V6 changes. Record results before and after performance or accuracy changes.

## Setup

- Build: `npm.cmd run build`
- Device/browser:
- Scanner mode: manual / auto
- Lighting:
- Background:
- Notes about camera distance/angle:

## Cards

| Case | Card tested | Expected result | Pass/Fail | Notes |
| --- | --- | --- | --- | --- |
| Normal black-border card |  | Correct card, no duplicate add |  |  |
| Full-art card |  | Physical card bounds detected, correct match |  |  |
| Borderless card |  | Physical card bounds detected, correct match |  |  |
| Dark card |  | Correct match without repeated failures |  |  |
| Foil/glare card |  | Correct match or foil fallback succeeds |  |  |
| Upside-down portrait card |  | Correct match through 180-degree fallback |  |  |
| Sideways card |  | Rejected / not matched, no distorted false add |  |  |
| Similar printings/art |  | Correct card or acceptable same-name cluster |  |  |
| Locked set enabled |  | Rejects cards outside locked set |  |  |
| Manual reticle fallback |  | Manual scan can match when corners fail |  |  |
| Auto-scan duplicate prevention |  | Stationary card is not repeatedly added |  |  |
| Auto-scan card leave/re-enter |  | Same card can be added again after leaving frame |  |  |
| Web partial cache offline |  | Scanner can match against cached hashes |  |  |
| Native slow SQLite startup |  | Startup falls back cleanly without mixed DB state |  |  |

## Debug Metrics

Enable `DEBUG` in `src/scanner/CardScanner.jsx` only during local testing. Record the debug strip timing values:

| Case | cap | det | warp | ret | chm | total | Distance/gap/source | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Normal black-border card |  |  |  |  |  |  |  |  |
| Full-art card |  |  |  |  |  |  |  |  |
| Borderless card |  |  |  |  |  |  |  |  |
| Dark card |  |  |  |  |  |  |  |  |
| Foil/glare card |  |  |  |  |  |  |  |  |

## Regression Notes

- False positives:
- False negatives:
- Duplicate adds:
- Startup/cache issues:
- UI jank:

