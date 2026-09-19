// Measures actual ready-and-painted frames, not just iframe URL changes.
import('../store/tools/experience-tests/performance.mjs').catch(error => { console.error(error); process.exitCode = 1; });
