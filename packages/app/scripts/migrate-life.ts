import { resolveGestaltHome } from "../src/home/resolveGestaltHome";
import { migrateHomeToLife } from "../src/life/migrate";

const homePath = process.argv[2] ?? process.env.GESTALT_HOME;
if (!homePath) {
  console.error("Usage: tsx scripts/migrate-life.ts <GestaltHome>");
  process.exit(1);
}

const home = await resolveGestaltHome({ homePath, create: false });
const result = await migrateHomeToLife(home, new Date());
console.log(JSON.stringify({ gestaltHome: home.root, ...result }, null, 2));
