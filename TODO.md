# TODO

- Disable the scripted/default playthrough path. It was useful only as a smoke test
  while OpenRouter credentials were missing; it is not a meaningful benchmark
  playtester.
- Make agent mode the required/default playthrough mode for RunWave fleet jobs.
- Fail clearly when agent mode is requested but no OpenRouter key is available.
- Re-run the single-game Mario smoke with the real agent path, then expand to a
  small multi-game batch before attempting the 20-game fleet.
- Add an automatic `playthrough_quality.json` checker for boss criteria:
  duration around 2 minutes, menu cleared, movement games reaching at least four
  substantially new frames, non-movement games completing at least five
  meaningful actions, and per-step model latency.
- Test grid screenshots on vs off. Current grid may help menu clicks but may
  also slow the loop because it rewrites PNG screenshots.
- Add or test a menu recovery tool such as mega-click only after observing the
  first agentic run.
