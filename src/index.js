import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { BukConversationalAgent } from "./agent.js";
import { config } from "./config.js";

async function main() {
  const agent = new BukConversationalAgent();
  const rl = readline.createInterface({ input, output });

  console.log(
    `Agente BUK listo (${config.mode}). Escribe 'ayuda' para ver comandos.`
  );

  try {
    while (true) {
      const message = await rl.question("buk> ");

      try {
        const response = await agent.handleInput(message);

        if (typeof response === "object" && response?.shouldExit) {
          console.log(response.message);
          break;
        }

        console.log(response);
      } catch (error) {
        console.error(`Error: ${error.message}`);
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(`Error fatal: ${error.message}`);
  process.exitCode = 1;
});
