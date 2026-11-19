import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const program = fileURLToPath(new URL("../prolog/gato.pl", import.meta.url));
export function decide(
  board,
  { binary = process.env.SWIPL_PATH || "swipl" } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      ["-q", "-s", program, "-g", "main", "-t", "halt"],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], timeout: 8000 },
    );
    let out = "",
      err = "",
      settled = false;
    const fail = (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    };
    child.on("error", fail);
    child.stdout.on("data", (b) => {
      out += b;
      if (out.length > 65536) {
        child.kill();
        fail(new Error("Respuesta Prolog demasiado grande."));
      }
    });
    child.stderr.on("data", (b) => {
      err += b.toString().slice(0, 2048);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0)
        return reject(new Error("No se pudo calcular la jugada de Prolog."));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("Respuesta Prolog inválida."));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(
      JSON.stringify({ board: board.map((v) => v || "e"), player: "O" }) + "\n",
    );
  });
}
