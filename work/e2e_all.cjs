// Compatibility entry point. The maintained suite checks this checkout's actual viewer and artifacts.
import('../store/tools/experience-tests/browser.mjs').catch(error => { console.error(error); process.exitCode = 1; });
