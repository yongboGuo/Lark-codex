import { loadConfig } from "./config/env.js";
import { App } from "./core/app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = new App(config);

  if (process.argv.includes("--demo")) {
    const response = await app.handleIncoming({
      messageId: "demo-1",
      chatId: "demo-chat",
      chatType: "p2p",
      text: "/status"
    });
    console.log(response);
    process.exit(0);
    return;
  }

  await app.start();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
