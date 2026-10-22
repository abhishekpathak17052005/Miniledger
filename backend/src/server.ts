import "dotenv/config";
import { app } from "./app.js";
import { prisma } from "./prisma.js";

const port = Number(process.env.PORT ?? 4000);
const server = app.listen(port, () => console.info(`MiniLedger API listening on http://localhost:${port}`));

async function shutdown() {
  server.close();
  await prisma.$disconnect();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
