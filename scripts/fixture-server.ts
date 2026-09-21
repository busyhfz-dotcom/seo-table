/** Serve the test fixture site on a fixed port, for manual and smoke testing. */
import { startFixture } from "../tests/fixture-site.js";

startFixture(Number(process.env.FIXTURE_PORT ?? 4555)).then((f) => {
  console.log(`fixture site on ${f.baseUrl}`);
});
